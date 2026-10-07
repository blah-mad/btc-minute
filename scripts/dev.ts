import express from 'express';
import { createServer as createViteServer } from 'vite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { createAuth } from '../src/auth/index.js';
import { CoinbasePriceProvider, DynamoGameRepository, GameService, type PriceProvider } from '../src/game/index.js';
import { createHttpHandler } from '../src/server/http.js';
import { localDocumentClient, setupTables, startLocalDatabase } from './local-db.js';

if (process.env.AWS_LAMBDA_FUNCTION_NAME) throw new Error('Development server must not run in Lambda.');
const databaseProcess = await startLocalDatabase();
const port = Number(process.env.PORT ?? 5173);
const origin = `http://127.0.0.1:${port}`;
const tableSuffix = process.env.LOCAL_TABLE_SUFFIX ?? 'dev';
if (!/^[a-zA-Z0-9-]+$/.test(tableSuffix)) throw new Error('Invalid local table suffix.');
const gameTable = `btc-minute-game-${tableSuffix}`;
const authTable = `btc-minute-auth-${tableSuffix}`;
await setupTables(gameTable, authTable);
mkdirSync('.local', { recursive: true });
const secretPath = '.local/auth-secret';
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(48).toString('hex'), { mode: 0o600 });
let prices: PriceProvider = new CoinbasePriceProvider();
if (process.env.LOCAL_PRICE_FIXTURE === 'up') {
  console.log('TEST FIXTURE: deterministic prices. Do not use this mode for the live demo.');
  prices = { async getQuote() { const now = Date.now(); return { price: (60_000 + Math.floor(now / 1000)).toFixed(2), tradeId: String(now), timestamp: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), source: 'Coinbase' }; } };
}
const game = new GameService(new DynamoGameRepository(localDocumentClient, gameTable), prices);
const auth = createAuth({ documentClient: localDocumentClient, tableName: authTable, baseURL: origin, secret: readFileSync(secretPath, 'utf8'), identityStore: game });
const handle = createHttpHandler(auth, game, origin);
const app = express();
app.disable('x-powered-by');
app.use('/api', express.raw({ type: () => true, limit: '32kb' }));
app.use(async (req, res, next) => {
  if (!req.path.startsWith('/api/')) return next();
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    headers.set('x-btc-client-ip', req.socket.remoteAddress ?? '127.0.0.1');
    const response = await handle(new Request(`${origin}${req.originalUrl}`, { method: req.method, headers, ...(!['GET', 'HEAD'].includes(req.method) && req.body?.length ? { body: new Uint8Array(req.body) } : {}) }));
    response.headers.forEach((value, key) => { if (key !== 'set-cookie') res.setHeader(key, value); });
    if (response.headers.getSetCookie().length) res.setHeader('set-cookie', response.headers.getSetCookie());
    res.status(response.status).send(await response.text());
  } catch (error) { next(error); }
});
// Browser tests exercise the built assets without development HMR connections.
const vite = process.env.LOCAL_STATIC === 'true' ? undefined : await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
app.use(vite ? vite.middlewares : express.static(resolve('dist')));
const server = app.listen(port, '127.0.0.1', () => console.log(`BTC Minute ready at ${origin} (DynamoDB Local; no AWS account access).`));
let processing = false;
const timer = setInterval(async () => {
  if (processing) return;
  processing = true;
  try {
    for (const guess of await game.listPending()) if (Date.parse(guess.eligibleAt) <= Date.now()) await game.settle(guess.playerId, guess.id);
  } catch (error) { console.error('Local settlement retry:', error instanceof Error ? error.message : 'unknown'); }
  finally { processing = false; }
}, 2000);
async function shutdown() {
  clearInterval(timer);
  server.close();
  await vite?.close();
  databaseProcess?.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
