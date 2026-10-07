import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { buildTableDefinition, createSingleTableStore, deriveIndexMap, dynamoAdapter } from '@datar-platform/better-auth-dynamodb';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { getAuthTables } from 'better-auth/db';
import { anonymous } from 'better-auth/plugins';
import { dynamoRateLimit } from './rate-limit.js';
import { withConsistentIndexedReads } from './consistent-store.js';

export const AUTH_LOOKUP_SLOTS = 2;
export const AUTH_TTL_ATTRIBUTE = '__ba_ttl';
export const authTableDefinition = (tableName: string) => buildTableDefinition(tableName, AUTH_LOOKUP_SLOTS);

export interface IdentityStore {
  resolvePlayer(userId: string): Promise<string>;
  assertIdentityIdle(userId: string): Promise<void>;
  linkGuest(anonymousUserId: string, targetUserId: string, options: { adoptGuest: boolean }): Promise<string>;
}

export interface AuthOptions {
  documentClient: DynamoDBDocumentClient;
  tableName: string;
  baseURL: string;
  secret: string;
  identityStore: IdentityStore;
  /** Local tests can shorten expiry without changing production configuration. */
  sessionExpiresIn?: number;
}

const identityChanges = new Set(['/sign-in/email', '/sign-up/email', '/sign-out', '/sign-in/anonymous']);

async function guardIdentityChange(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ACTIVE_GUESS') {
      throw new APIError('CONFLICT', {
        code: 'ACTIVE_GUESS',
        message: 'Wait for your current guess to finish before changing accounts.',
      });
    }
    throw error;
  }
}

export function createAuth(options: AuthOptions) {
  const origin = new URL(options.baseURL).origin;
  const secure = new URL(origin).protocol === 'https:';
  if (options.secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters.');
  const guestPlugin = anonymous({ generateName: () => 'Guest' });
  const indexMap = deriveIndexMap(getAuthTables({ plugins: [guestPlugin], emailAndPassword: { enabled: true } }));
  const store = withConsistentIndexedReads(createSingleTableStore({
    documentClient: options.documentClient,
    tableName: options.tableName,
    indexMap,
    atomicUniqueness: true,
    ttl: { defaultField: 'expiresAt' },
  }));

  return betterAuth({
    appName: 'BTC Minute',
    baseURL: origin,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: [origin],
    disabledPaths: ['/delete-anonymous-user'],
    database: dynamoAdapter({
      store,
      indexMap,
    }),
    // This demo deliberately does not collect email-verification or recovery mail.
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      requireEmailVerification: false,
      autoSignIn: true,
    },
    session: {
      expiresIn: options.sessionExpiresIn ?? 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    verification: { disableCleanup: true },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: secure,
      cookiePrefix: 'btc-minute',
      defaultCookieAttributes: { httpOnly: true, secure, sameSite: 'lax', path: '/' },
      // API/Express entry points overwrite this with their trusted socket/gateway IP.
      ipAddress: { ipAddressHeaders: ['x-btc-client-ip'] },
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customStorage: dynamoRateLimit(options.documentClient, options.tableName),
      customRules: {
        '/sign-in/anonymous': { window: 60, max: 10 },
        '/sign-in/email': { window: 60, max: 10 },
        '/sign-up/email': { window: 60, max: 5 },
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (!identityChanges.has(ctx.path)) return;
        const current = await getSessionFromCtx(ctx, { disableRefresh: true });
        if (current) await guardIdentityChange(() => options.identityStore.assertIdentityIdle(current.user.id));
        if (current?.user.isAnonymous && ctx.path === '/sign-out') {
          throw new APIError('FORBIDDEN', {
            code: 'GUEST_SESSION',
            message: 'Create an account or sign in to keep your guest progress accessible.',
          });
        }
        if (current && ctx.path === '/sign-in/anonymous') {
          throw new APIError('CONFLICT', { code: 'ALREADY_SIGNED_IN', message: 'You are already signed in.' });
        }
      }),
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => {
            // This hook runs after password verification, before issuing a session.
            // Linking in the anonymous plugin's after hook would be too late if it fails.
            if (!ctx || !['/sign-in/email', '/sign-up/email'].includes(ctx.path)) return;
            await guardIdentityChange(() => options.identityStore.assertIdentityIdle(session.userId));
            const current = await getSessionFromCtx(ctx, { disableRefresh: true });
            if (current?.user.isAnonymous && current.user.id !== session.userId) {
              await guardIdentityChange(() => options.identityStore.linkGuest(current.user.id, session.userId, {
                adoptGuest: ctx.path === '/sign-up/email',
              }));
            }
          },
        },
      },
    },
    plugins: [guestPlugin],
  });
}

export type AppAuth = ReturnType<typeof createAuth>;
