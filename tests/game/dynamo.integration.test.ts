import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DynamoGameRepository, GameService } from '../../src/game/index.js';
import type { Quote } from '../../src/shared/types.js';

const endpoint = process.env.DYNAMODB_LOCAL_ENDPOINT ?? 'http://127.0.0.1:8010';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) {
  throw new Error('Game integration tests require a loopback DynamoDB Local endpoint.');
}
const enabled = process.env.RUN_DYNAMODB_TESTS === '1';

describe.skipIf(!enabled)('DynamoDB transaction guarantees', () => {
  const tableName = `btc-game-test-${randomUUID()}`;
  const raw = new DynamoDBClient({ endpoint, region: 'eu-central-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  const db = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
  const repository = new DynamoGameRepository(db, tableName);
  beforeAll(async () => {
    await raw.send(new CreateTableCommand({ TableName: tableName, BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }],
    }));
  }, 30_000);
  afterAll(async () => { await raw.send(new DeleteTableCommand({ TableName: tableName })); raw.destroy(); });

  async function fixture(userId = randomUUID()) {
    let now = Date.parse('2026-10-08T12:00:00.000Z');
    let price = '100';
    const prices = { getQuote: async (): Promise<Quote> => ({ price, timestamp: new Date(now).toISOString(), receivedAt: new Date(now).toISOString(), tradeId: String(now), source: 'Coinbase' }) };
    const service = new GameService(repository, prices, { now: () => now });
    return { userId, service, playerId: await service.resolvePlayer(userId), advance: (ms: number) => { now += ms; }, price: (p: string) => { price = p; } };
  }

  it('concurrent first sessions create exactly one player profile', async () => {
    const userId = randomUUID();
    const players = await Promise.all(Array.from({ length: 8 }, () => repository.resolvePlayer(userId)));
    expect(new Set(players).size).toBe(1);
    expect(await repository.getPlayer(players[0])).toMatchObject({ score: 0, roundCount: 0 });
  });

  it('atomically accepts one of eight simultaneous guesses, retains the receipt, and settles once', async () => {
    const f = await fixture();
    const requestIds = Array.from({ length: 8 }, () => randomUUID());
    const submissions = await Promise.allSettled(requestIds.map((id) => f.service.placeGuess(f.playerId, 'up', id)));
    expect(submissions.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const acceptedIndex = submissions.findIndex((result) => result.status === 'fulfilled');
    const state = await f.service.getState(f.playerId);
    const guessId = state.activeGuess!.id;
    expect(await repository.getPlayer(f.playerId)).toMatchObject({ roundCount: 1 });
    expect(await repository.getRequest(f.playerId, requestIds[acceptedIndex])).toEqual({ guessId, direction: 'up' });
    f.advance(60_000); f.price('101');
    const results = await Promise.all(Array.from({ length: 8 }, () => f.service.settle(f.playerId, guessId)));
    expect(results.filter((result) => result.status === 'resolved')).toHaveLength(1);
    expect(await f.service.getState(f.playerId)).toMatchObject({ score: 1, activeGuess: null, lastResult: { id: guessId, settlementPrice: '101' } });
    expect(await f.service.placeGuess(f.playerId, 'up', requestIds[acceptedIndex])).toMatchObject({ score: 1, activeGuess: null });
  });

  it('collapses simultaneous retries with the same request ID to one guess', async () => {
    const f = await fixture();
    const id = randomUUID();
    const states = await Promise.all(Array.from({ length: 8 }, () => f.service.placeGuess(f.playerId, 'down', id)));
    expect(new Set(states.map((state) => state.activeGuess!.id)).size).toBe(1);
    expect(await repository.getPlayer(f.playerId)).toMatchObject({ roundCount: 1 });
    await expect(f.service.placeGuess(f.playerId, 'up', id)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('keeps independent player transactions isolated and scores negative correctly', async () => {
    const [first, second] = await Promise.all([fixture(), fixture()]);
    const [a, b] = await Promise.all([first.service.placeGuess(first.playerId, 'up', randomUUID()), second.service.placeGuess(second.playerId, 'down', randomUUID())]);
    first.advance(60_000); first.price('99'); second.advance(60_000); second.price('99');
    await Promise.all([first.service.settle(first.playerId, a.activeGuess!.id), second.service.settle(second.playerId, b.activeGuess!.id)]);
    expect((await first.service.getState(first.playerId)).score).toBe(-1);
    expect((await second.service.getState(second.playerId)).score).toBe(1);
  });

  it('adopts guest progress on signup idempotently and retires the unused target player', async () => {
    const guest = await fixture();
    const target = await fixture();
    const state = await guest.service.placeGuess(guest.playerId, 'down', randomUUID());
    guest.advance(60_000); guest.price('99');
    await guest.service.settle(guest.playerId, state.activeGuess!.id);
    const linked = await repository.linkGuest(guest.userId, target.userId, { adoptGuest: true });
    expect(linked).toBe(guest.playerId);
    expect(await repository.linkGuest(guest.userId, target.userId, { adoptGuest: true })).toBe(linked);
    expect(await repository.resolvePlayer(target.userId)).toBe(guest.playerId);
    expect((await target.service.getState(linked)).score).toBe(1);
    await expect(repository.resolvePlayer(guest.userId)).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
    await expect(target.service.placeGuess(target.playerId, 'up', randomUUID())).rejects.toMatchObject({ code: 'PLAYER_REPLACED' });
    await expect(repository.linkGuest(guest.userId, randomUUID())).rejects.toMatchObject({ code: 'SESSION_REPLACED' });
  });

  it('keeps an existing account score even when it has no past rounds; never sums guest scores', async () => {
    const guest = await fixture();
    const target = await fixture();
    const state = await guest.service.placeGuess(guest.playerId, 'up', randomUUID());
    guest.advance(60_000); guest.price('99');
    await guest.service.settle(guest.playerId, state.activeGuess!.id);
    expect(await repository.linkGuest(guest.userId, target.userId, { adoptGuest: false })).toBe(target.playerId);
    expect((await target.service.getState(target.playerId)).score).toBe(0);
    await expect(guest.service.placeGuess(guest.playerId, 'up', randomUUID())).rejects.toMatchObject({ code: 'PLAYER_REPLACED' });
    // Queue delivery can lag behind account switching. Duplicate completed jobs
    // should acknowledge successfully instead of looping into the dead-letter queue.
    expect(await guest.service.settle(guest.playerId, state.activeGuess!.id)).toMatchObject({ status: 'already-resolved', state: { score: -1 } });
  });

  it('blocks linking when either account has an active round', async () => {
    const guest = await fixture(); const target = await fixture();
    const current = await guest.service.placeGuess(guest.playerId, 'up', randomUUID());
    await expect(repository.linkGuest(guest.userId, target.userId)).rejects.toMatchObject({ code: 'ACTIVE_GUESS' });
    await expect(repository.assertIdentityIdle(guest.userId)).rejects.toMatchObject({ code: 'ACTIVE_GUESS' });
    expect(await repository.resolvePlayer(guest.userId)).toBe(guest.playerId);
    guest.advance(60_000); guest.price('101'); await guest.service.settle(guest.playerId, current.activeGuess!.id);
    await target.service.placeGuess(target.playerId, 'up', randomUUID());
    await expect(repository.linkGuest(guest.userId, target.userId)).rejects.toMatchObject({ code: 'ACTIVE_GUESS' });
  });

  it('serializes concurrent guest linking and guess acceptance without orphaning an active round', async () => {
    const guest = await fixture(); const target = await fixture();
    const results = await Promise.allSettled([
      guest.service.placeGuess(guest.playerId, 'up', randomUUID()),
      repository.linkGuest(guest.userId, target.userId, { adoptGuest: false }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const profile = await repository.getPlayer(guest.playerId);
    expect(Boolean(profile!.activeGuessId) && Boolean(profile!.retiredTo)).toBe(false);
  });

  it('exposes pending GUESS records for recovery with the documented stream shape', async () => {
    const f = await fixture();
    const state = await f.service.placeGuess(f.playerId, 'up', randomUUID());
    expect(await repository.listPending()).toContainEqual(state.activeGuess);
    const records = await db.send(new ScanCommand({ TableName: tableName }));
    const stored = records.Items!.find((item) => item.id === state.activeGuess!.id);
    expect(stored).toMatchObject({ pk: `PLAYER#${f.playerId}`, sk: `GUESS#${state.activeGuess!.id}`, entity: 'GUESS', playerId: f.playerId, eligibleAt: state.activeGuess!.eligibleAt });
  });
});
