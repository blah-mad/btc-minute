import { describe, expect, it, vi } from 'vitest';
import { CoinbasePriceProvider, validateFreshQuote } from '../../src/game/index.js';
import type { Quote } from '../../src/shared/types.js';

const now = Date.parse('2026-10-08T12:00:00.000Z');
const quote = (changes: Partial<Quote> = {}): Quote => ({
  price: '62341.01000000', tradeId: '123', timestamp: new Date(now).toISOString(),
  receivedAt: new Date(now).toISOString(), source: 'Coinbase', ...changes,
});

describe('Coinbase price boundary', () => {
  it('retains the decimal price and market trade identity without floating point conversion', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ price: '62341.01000000', trade_id: 123, time: new Date(now).toISOString() }));
    const provider = new CoinbasePriceProvider(fetcher, () => now);
    expect(await provider.getQuote()).toEqual(quote());
    expect(fetcher).toHaveBeenCalledWith('https://api.exchange.coinbase.com/products/BTC-USD/ticker', expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }));
  });

  it.each([
    { price: '0', trade_id: 1, time: new Date(now).toISOString() },
    { price: '-1', trade_id: 1, time: new Date(now).toISOString() },
    { price: 'NaN', trade_id: 1, time: new Date(now).toISOString() },
    { price: '100', trade_id: 1.5, time: new Date(now).toISOString() },
    { price: '100', trade_id: 1, time: 'not-a-time' },
  ])('rejects malformed market data %#', async (response) => {
    const provider = new CoinbasePriceProvider(vi.fn<typeof fetch>().mockResolvedValue(Response.json(response)), () => now);
    await expect(provider.getQuote()).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE', status: 503 });
  });

  it('treats provider throttling as unavailable, not a game result', async () => {
    const provider = new CoinbasePriceProvider(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429 })), () => now);
    await expect(provider.getQuote()).rejects.toMatchObject({ code: 'PRICE_UNAVAILABLE' });
  });

  it('accepts only the documented quote age and clock-skew bounds', () => {
    expect(validateFreshQuote(quote({ timestamp: new Date(now - 9_999).toISOString() }), now)).toBeDefined();
    expect(validateFreshQuote(quote({ timestamp: new Date(now + 5_000).toISOString() }), now)).toBeDefined();
    expect(() => validateFreshQuote(quote({ timestamp: new Date(now - 10_000).toISOString() }), now)).toThrow();
    expect(() => validateFreshQuote(quote({ timestamp: new Date(now + 5_001).toISOString() }), now)).toThrow();
    expect(() => validateFreshQuote(quote({ receivedAt: new Date(now - 10_000).toISOString() }), now)).toThrow();
  });
});
