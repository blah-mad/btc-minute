import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ensureSchema } from '@datar-platform/better-auth-dynamodb';
import { createAuth, AUTH_LOOKUP_SLOTS } from '../../src/auth/index.js';
import { DynamoGameRepository, GameService } from '../../src/game/index.js';

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8010';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) {
  throw new Error('Auth integration tests require a loopback DynamoDB Local endpoint.');
}

describe.skipIf(process.env.RUN_DYNAMODB_TESTS !== '1')('persisted game and auth integration', () => {
  const suffix = randomUUID();
  const authTable = `btc-auth-link-${suffix}`;
  const gameTable = `btc-game-link-${suffix}`;
  const raw = new DynamoDBClient({ endpoint, region: 'eu-central-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  const documentClient = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  const repository = new DynamoGameRepository(documentClient, gameTable);
  let currentTime = Date.now();
  let currentPrice = '100';
  const game = new GameService(repository, { getQuote: async () => ({
    price: currentPrice, timestamp: new Date(currentTime).toISOString(), receivedAt: new Date(currentTime).toISOString(),
    tradeId: String(currentTime), source: 'Coinbase',
  }) }, { now: () => currentTime });
  const origin = 'http://localhost:5173';
  const auth = createAuth({ documentClient, tableName: authTable, baseURL: origin, secret: randomBytes(32).toString('hex'), identityStore: game });
  const cookies = new Map<string, string>();
  const cookie = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  async function post(path: string, body: Record<string, unknown> = {}) {
    const response = await auth.handler(new Request(`${origin}/api/auth${path}`, {
      method: 'POST', headers: { origin, cookie: cookie(), 'x-btc-client-ip': '127.0.0.2', 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    for (const setCookie of response.headers.getSetCookie()) {
      const pair = setCookie.split(';')[0];
      const at = pair.indexOf('=');
      const name = pair.slice(0, at), value = pair.slice(at + 1);
      if (value) cookies.set(name, value); else cookies.delete(name);
    }
    return response;
  }
  beforeAll(async () => {
    await ensureSchema({ client: raw, tableName: authTable, lookupSlots: AUTH_LOOKUP_SLOTS, ttlAttribute: '__ba_ttl' });
    await raw.send(new CreateTableCommand({
      TableName: gameTable, BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    }));
  });
  afterAll(async () => {
    await Promise.all([authTable, gameTable].map((TableName) => raw.send(new DeleteTableCommand({ TableName }))));
    raw.destroy();
  });

  it('preserves completed guest rounds on signup and restores an existing score without merging scores', async () => {
    const guestResponse = await post('/sign-in/anonymous');
    expect(guestResponse.status).toBe(200);
    const guestId = (await guestResponse.json()).user.id;
    const originalCookie = cookie();
    const playerId = await game.resolvePlayer(guestId);
    const pending = await game.placeGuess(playerId, 'up', randomUUID());
    const email = `linked-${suffix}@example.test`;
    const credentials = { name: 'Player', email, password: 'sample-long-password' };
    expect((await post('/sign-up/email', credentials)).status).toBe(409);
    expect((await post('/sign-out')).status).toBe(409);
    expect((await game.getState(playerId)).activeGuess?.id).toBe(pending.activeGuess!.id);

    currentTime += 60_000;
    currentPrice = '101';
    const completed = await game.settle(playerId, pending.activeGuess!.id);
    expect(completed.state.score).toBe(1);
    // Guests cannot accidentally discard their only way back to this identity.
    expect((await post('/sign-out')).status).toBe(403);
    const signup = await post('/sign-up/email', credentials);
    expect(signup.status).toBe(200);
    const accountId = (await signup.json()).user.id;
    expect(await game.resolvePlayer(accountId)).toBe(playerId);
    expect((await game.getState(playerId)).score).toBe(1);
    expect((await game.getState(playerId)).lastResult?.id).toBe(pending.activeGuess!.id);
    await expect(game.resolvePlayer(guestId)).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    expect(await auth.api.getSession({ headers: new Headers({ cookie: originalCookie }) })).toBeNull();

    expect((await post('/sign-out')).status).toBe(200);
    const anotherGuest = await post('/sign-in/anonymous');
    expect(anotherGuest.status).toBe(200);
    const anotherId = (await anotherGuest.json()).user.id;
    const anotherPlayer = await game.resolvePlayer(anotherId);
    const anotherRound = await game.placeGuess(anotherPlayer, 'up', randomUUID());
    currentTime += 60_000;
    currentPrice = '100';
    expect((await game.settle(anotherPlayer, anotherRound.activeGuess!.id)).state.score).toBe(-1);
    expect((await post('/sign-in/email', { email, password: credentials.password })).status).toBe(200);
    const restored = await auth.api.getSession({ headers: new Headers({ cookie: cookie() }) });
    expect(restored?.user.id).toBe(accountId);
    expect(await game.resolvePlayer(accountId)).toBe(playerId);
    expect((await game.getState(playerId)).score).toBe(1);
    await expect(game.resolvePlayer(anotherId)).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    await expect(game.placeGuess(anotherPlayer, 'up', randomUUID())).rejects.toMatchObject({ code: 'PLAYER_REPLACED' });
  });
});
