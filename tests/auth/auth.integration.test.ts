import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ensureSchema } from '@datar-platform/better-auth-dynamodb';
import { createAuth, AUTH_LOOKUP_SLOTS, type AppAuth, type IdentityStore } from '../../src/auth/index.js';
import { dynamoRateLimit } from '../../src/auth/rate-limit.js';

// This suite never reads AWS profiles or contacts an AWS account.
const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8010';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) {
  throw new Error('Auth integration tests require a loopback DynamoDB Local endpoint.');
}
const enabled = process.env.RUN_DYNAMODB_TESTS === '1';

class TestIdentities implements IdentityStore {
  readonly players = new Map<string, string>();
  readonly scores = new Map<string, number>();
  readonly pending = new Set<string>();
  readonly links: Array<{ source: string; target: string; adopt: boolean }> = [];
  async resolvePlayer(userId: string) {
    if (!this.players.has(userId)) {
      const id = randomUUID();
      this.players.set(userId, id);
      this.scores.set(id, 0);
    }
    return this.players.get(userId)!;
  }
  async assertIdentityIdle(userId: string) {
    if (this.pending.has(userId)) throw Object.assign(new Error('A round is pending.'), { code: 'ACTIVE_GUESS' });
  }
  async linkGuest(source: string, target: string, options: { adoptGuest: boolean }) {
    await this.assertIdentityIdle(source);
    await this.assertIdentityIdle(target);
    this.links.push({ source, target, adopt: options.adoptGuest });
    if (options.adoptGuest) this.players.set(target, await this.resolvePlayer(source));
    return this.resolvePlayer(target);
  }
}

class BrowserSession {
  private cookies = new Map<string, string>();
  constructor(private readonly auth: AppAuth, private readonly origin = 'http://localhost:5173') {}
  get cookie() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  async request(path: string, body?: Record<string, unknown>, extraHeaders: Record<string, string> = {}) {
    const response = await this.auth.handler(new Request(`${this.origin}/api/auth${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        origin: this.origin,
        'content-type': 'application/json',
        'x-btc-client-ip': '127.0.0.1',
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...extraHeaders,
      },
      body: body ? JSON.stringify(body) : undefined,
    }));
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const position = pair.indexOf('=');
      const name = pair.slice(0, position);
      const value = pair.slice(position + 1);
      if (!value || /max-age=0/i.test(header)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }
}

describe.skipIf(!enabled)('Better Auth with DynamoDB Local', () => {
  const tableName = `btc-auth-test-${randomUUID()}`;
  const raw = new DynamoDBClient({ endpoint, region: 'eu-central-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  const documentClient = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  const identities = new TestIdentities();
  const secret = randomBytes(32).toString('hex');
  const makeAuth = (baseURL = 'http://localhost:5173', sessionExpiresIn?: number) => createAuth({
    documentClient, tableName, baseURL, secret, identityStore: identities, sessionExpiresIn,
  });
  const auth = makeAuth();
  const password = 'sample-interview-password';
  beforeAll(async () => {
    await ensureSchema({ client: raw, tableName, lookupSlots: AUTH_LOOKUP_SLOTS, ttlAttribute: '__ba_ttl' });
  }, 30_000);
  afterAll(async () => {
    await raw.send(new DeleteTableCommand({ TableName: tableName }));
    raw.destroy();
  });

  it('persists a guest session, adopts progress on signup, and restores the same account after logout', async () => {
    const browser = new BrowserSession(auth);
    const guestResponse = await browser.request('/sign-in/anonymous', {});
    expect(guestResponse.status).toBe(200);
    expect(guestResponse.headers.get('set-cookie')).toContain('HttpOnly');
    const guest = (await guestResponse.json()).user;
    const playerId = await identities.resolvePlayer(guest.id);
    identities.scores.set(playerId, 4);
    const restored = await auth.api.getSession({ headers: new Headers({ cookie: browser.cookie }) });
    expect(restored?.user.id).toBe(guest.id);

    const email = `new-${randomUUID()}@example.test`;
    const signup = await browser.request('/sign-up/email', { name: 'Player', email, password });
    expect(signup.status).toBe(200);
    const registered = (await signup.json()).user;
    expect(registered.id).not.toBe(guest.id);
    expect(await identities.resolvePlayer(registered.id)).toBe(playerId);
    expect(identities.scores.get(playerId)).toBe(4);
    expect(identities.links.at(-1)).toEqual({ source: guest.id, target: registered.id, adopt: true });
    expect((await browser.request('/sign-out', {})).status).toBe(200);
    expect(await auth.api.getSession({ headers: new Headers({ cookie: browser.cookie }) })).toBeNull();
    expect((await browser.request('/sign-in/email', { email, password })).status).toBe(200);
    const returned = await auth.api.getSession({ headers: new Headers({ cookie: browser.cookie }) });
    expect(returned?.user.id).toBe(registered.id);
    expect(await identities.resolvePlayer(returned!.user.id)).toBe(playerId);
  });

  it('keeps an existing account score when a guest signs in', async () => {
    const accountBrowser = new BrowserSession(auth);
    const email = `existing-${randomUUID()}@example.test`;
    const signup = await accountBrowser.request('/sign-up/email', { name: 'Existing', email, password });
    expect(signup.status).toBe(200);
    const account = (await signup.json()).user;
    const accountPlayer = await identities.resolvePlayer(account.id);
    identities.scores.set(accountPlayer, -2);
    const browser = new BrowserSession(auth);
    const guest = (await (await browser.request('/sign-in/anonymous', {})).json()).user;
    identities.scores.set(await identities.resolvePlayer(guest.id), 8);
    const signedIn = await browser.request('/sign-in/email', { email, password });
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).user.id).toBe(account.id);
    expect(identities.links.at(-1)).toEqual({ source: guest.id, target: account.id, adopt: false });
    expect(identities.scores.get(accountPlayer)).toBe(-2);
  });

  it('rejects account changes during a pending round without replacing the guest cookie', async () => {
    const browser = new BrowserSession(auth);
    const guestResponse = await browser.request('/sign-in/anonymous', {});
    const guest = (await guestResponse.json()).user;
    identities.pending.add(guest.id);
    for (const [path, body] of [
      ['/sign-out', {}],
      ['/sign-up/email', { name: 'Blocked', email: `pending-${randomUUID()}@example.test`, password }],
      ['/sign-in/email', { email: 'absent@example.test', password }],
    ] as const) {
      const response = await browser.request(path, body);
      expect(response.status).toBe(409);
      expect((await response.json()).code).toBe('ACTIVE_GUESS');
    }
    const session = await auth.api.getSession({ headers: new Headers({ cookie: browser.cookie }) });
    expect(session?.user.id).toBe(guest.id);
    identities.pending.delete(guest.id);
  });

  it('uses Secure cookies over HTTPS and rejects forged sessions and cross-origin writes', async () => {
    const secureAuth = makeAuth('https://btc.example.test');
    const browser = new BrowserSession(secureAuth, 'https://btc.example.test');
    const signedIn = await browser.request('/sign-in/anonymous', {});
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.get('set-cookie')).toContain('Secure');
    expect(signedIn.headers.get('set-cookie')).toContain('HttpOnly');
    expect(await secureAuth.api.getSession({ headers: new Headers({ cookie: '__Secure-btc-minute.session_token=forged' }) })).toBeNull();
    const crossOrigin = await browser.request('/sign-out', {}, { origin: 'https://attacker.example.test' });
    expect(crossOrigin.status).toBe(403);
  });

  it('rejects an expired session even before DynamoDB TTL removes it', async () => {
    const shortAuth = makeAuth('http://localhost:5173', 1);
    const browser = new BrowserSession(shortAuth);
    expect((await browser.request('/sign-in/anonymous', {})).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    expect(await shortAuth.api.getSession({ headers: new Headers({ cookie: browser.cookie }) })).toBeNull();
  });

  it('shares atomic rate limits across concurrent Lambda instances', async () => {
    const now = () => 1_000_000;
    const rateA = dynamoRateLimit(documentClient, tableName, now);
    const rateB = dynamoRateLimit(documentClient, tableName, now);
    const attempts = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      (index % 2 ? rateA : rateB).consume('concurrent-test', { window: 60, max: 5 })));
    expect(attempts.filter((attempt) => attempt.allowed)).toHaveLength(5);
    expect(attempts.filter((attempt) => !attempt.allowed).every((attempt) => attempt.retryAfter === 20)).toBe(true);
  });
});
