import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { GameService } from '../../src/game/index.js';
import type { Direction, Quote } from '../../src/shared/types.js';
import { MemoryGameRepository } from './memory-repository.js';

async function fixture() {
  let now = Date.parse('2026-10-08T12:00:00.000Z');
  let price = '100';
  let timestampOffset = 0;
  const repository = new MemoryGameRepository();
  const getQuote = vi.fn(async (): Promise<Quote> => ({
    price, timestamp: new Date(now + timestampOffset).toISOString(), receivedAt: new Date(now).toISOString(),
    tradeId: String(now), source: 'Coinbase',
  }));
  const service = new GameService(repository, { getQuote }, { now: () => now });
  const playerId = await service.resolvePlayer('user-1');
  return { repository, service, playerId, getQuote, advance: (ms: number) => { now += ms; }, setPrice: (p: string) => { price = p; }, setOffset: (offset: number) => { timestampOffset = offset; }, now: () => now };
}

describe('game rules', () => {
  it('starts at zero and restores the same stable player', async () => {
    const { service, playerId } = await fixture();
    expect(await service.resolvePlayer('user-1')).toBe(playerId);
    expect(await service.getState(playerId)).toMatchObject({ score: 0, activeGuess: null, lastResult: null });
  });

  it.each<[Direction, string, number]>([
    ['up', '100.01', 1], ['up', '99.99', -1], ['down', '99.99', 1], ['down', '100.01', -1],
  ])('scores %s with settlement %s as %s', async (direction, price, delta) => {
    const f = await fixture();
    const entered = await f.service.placeGuess(f.playerId, direction, randomUUID());
    expect(Date.parse(entered.activeGuess!.eligibleAt) - Date.parse(entered.activeGuess!.acceptedAt)).toBe(60_000);
    f.advance(60_000); f.setPrice(price);
    const settled = await f.service.settle(f.playerId, entered.activeGuess!.id);
    expect(settled.status).toBe('resolved');
    expect(settled.state).toMatchObject({ score: delta, activeGuess: null, lastResult: { delta, entryPrice: '100', settlementPrice: price, status: 'resolved' } });
  });

  it('does not fetch or settle at 59.999 seconds; becomes eligible at exactly 60', async () => {
    const f = await fixture();
    const { activeGuess } = await f.service.placeGuess(f.playerId, 'up', randomUUID());
    f.advance(59_999); f.setPrice('101');
    expect(await f.service.settle(f.playerId, activeGuess!.id)).toMatchObject({ status: 'pending', reason: 'too-early', retryAt: activeGuess!.eligibleAt });
    expect(f.getQuote).toHaveBeenCalledTimes(1);
    f.advance(1);
    expect((await f.service.settle(f.playerId, activeGuess!.id)).state.score).toBe(1);
  });

  it('keeps numerically equal prices pending, then resolves the next changed observation', async () => {
    const f = await fixture();
    const { activeGuess } = await f.service.placeGuess(f.playerId, 'down', randomUUID());
    f.advance(60_000); f.setPrice('100.00000000');
    expect(await f.service.settle(f.playerId, activeGuess!.id)).toMatchObject({ status: 'pending', reason: 'unchanged', state: { score: 0 } });
    await expect(f.service.placeGuess(f.playerId, 'up', randomUUID())).rejects.toMatchObject({ code: 'ACTIVE_GUESS' });
    f.advance(5_000); f.setPrice('99.9999999999999999');
    expect((await f.service.settle(f.playerId, activeGuess!.id)).state.score).toBe(1);
  });

  it('does not settle using a fresh but pre-deadline market trade', async () => {
    const f = await fixture();
    const { activeGuess } = await f.service.placeGuess(f.playerId, 'up', randomUUID());
    f.advance(60_000); f.setPrice('101'); f.setOffset(-1);
    expect(await f.service.settle(f.playerId, activeGuess!.id)).toMatchObject({ status: 'pending', reason: 'pre-deadline-quote', state: { score: 0 } });
  });

  it.each([-10_000, 5_001])('rejects entry quotes at timestamp offset %s and keeps no pending round', async (offset) => {
    const f = await fixture(); f.setOffset(offset);
    await expect(f.service.placeGuess(f.playerId, 'up', randomUUID())).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE', status: 503 });
    expect((await f.service.getState(f.playerId)).activeGuess).toBeNull();
  });

  it('keeps the score and round unchanged when the provider fails, then recovers', async () => {
    const f = await fixture();
    const { activeGuess } = await f.service.placeGuess(f.playerId, 'up', randomUUID());
    f.advance(60_000);
    f.getQuote.mockRejectedValueOnce(new Error('network down'));
    expect(await f.service.settle(f.playerId, activeGuess!.id)).toMatchObject({ status: 'pending', reason: 'price-unavailable', state: { score: 0 } });
    f.advance(5_000); f.setPrice('102');
    expect((await f.service.settle(f.playerId, activeGuess!.id)).state.score).toBe(1);
  });

  it('keeps stale settlement quotes pending without updating the score', async () => {
    const f = await fixture();
    const { activeGuess } = await f.service.placeGuess(f.playerId, 'down', randomUUID());
    f.advance(60_000); f.setPrice('101'); f.setOffset(-10_000);
    expect(await f.service.settle(f.playerId, activeGuess!.id)).toMatchObject({ status: 'pending', reason: 'price-unavailable', state: { score: 0 } });
  });

  it('persists idempotency across completion and rejects a reused ID with another direction', async () => {
    const f = await fixture();
    const requestId = randomUUID();
    const original = await f.service.placeGuess(f.playerId, 'up', requestId);
    expect((await f.service.placeGuess(f.playerId, 'up', requestId)).activeGuess!.id).toBe(original.activeGuess!.id);
    await expect(f.service.placeGuess(f.playerId, 'down', requestId)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    f.advance(60_000); f.setPrice('101');
    await f.service.settle(f.playerId, original.activeGuess!.id);
    expect(await f.service.placeGuess(f.playerId, 'up', requestId)).toMatchObject({ score: 1, activeGuess: null });
    expect(f.repository.guesses.size).toBe(1);
  });

  it('only accepts one concurrent guess and only scores one of several worker attempts', async () => {
    const f = await fixture();
    const submitted = await Promise.allSettled(Array.from({ length: 8 }, () => f.service.placeGuess(f.playerId, 'up', randomUUID())));
    expect(submitted.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const { activeGuess } = await f.service.getState(f.playerId);
    f.advance(60_000); f.setPrice('101');
    const settled = await Promise.all(Array.from({ length: 8 }, () => f.service.settle(f.playerId, activeGuess!.id)));
    expect(settled.filter((result) => result.status === 'resolved')).toHaveLength(1);
    expect((await f.service.getState(f.playerId)).score).toBe(1);
  });

  it('restores state after service restart with no browser-triggered settlement', async () => {
    const f = await fixture();
    const { activeGuess } = await f.service.placeGuess(f.playerId, 'down', randomUUID());
    f.advance(65_000); f.setPrice('105');
    const worker = new GameService(f.repository, { getQuote: f.getQuote }, { now: f.now });
    await worker.settle(f.playerId, activeGuess!.id);
    const restarted = new GameService(f.repository, { getQuote: f.getQuote }, { now: f.now });
    expect(await restarted.getState(await restarted.resolvePlayer('user-1'))).toMatchObject({ score: -1, activeGuess: null, lastResult: { id: activeGuess!.id } });
  });

  it('rejects malformed directions/IDs and cross-player settlement', async () => {
    const f = await fixture();
    await expect(f.service.placeGuess(f.playerId, 'sideways' as Direction, randomUUID())).rejects.toMatchObject({ code: 'INVALID_GUESS', status: 400 });
    await expect(f.service.placeGuess(f.playerId, 'up', 'reused')).rejects.toMatchObject({ code: 'INVALID_GUESS' });
    const { activeGuess } = await f.service.placeGuess(f.playerId, 'up', randomUUID());
    const other = await f.service.resolvePlayer('user-2');
    await expect(f.service.settle(other, activeGuess!.id)).rejects.toMatchObject({ code: 'GUESS_NOT_FOUND' });
  });
});
