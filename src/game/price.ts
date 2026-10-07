import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Quote } from '../shared/types.js';
import { GameError, type PriceProvider } from './contracts.js';

export const MAX_QUOTE_AGE_MS = 10_000;
export const MAX_CLOCK_SKEW_MS = 5_000;

const positiveDecimal = z.string().regex(/^\d{1,20}(\.\d{1,16})?$/).refine((value) => new Decimal(value).gt(0));
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const tickerSchema = z.object({
  price: positiveDecimal,
  trade_id: z.union([z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), z.string().regex(/^\d+$/)]),
  time: timestamp,
});
const quoteSchema = z.object({
  price: positiveDecimal,
  tradeId: z.string().min(1).max(100),
  timestamp,
  receivedAt: timestamp,
  source: z.literal('Coinbase'),
});

export function validateFreshQuote(quote: Quote, now: number): Quote {
  const parsed = quoteSchema.safeParse(quote);
  if (!parsed.success) throw new GameError('PRICE_UNAVAILABLE', 'The price provider returned invalid data. Try again shortly.', 503);
  const marketAge = now - Date.parse(quote.timestamp);
  const receivedAge = now - Date.parse(quote.receivedAt);
  if (marketAge >= MAX_QUOTE_AGE_MS || marketAge < -MAX_CLOCK_SKEW_MS || receivedAge >= MAX_QUOTE_AGE_MS || receivedAge < -MAX_CLOCK_SKEW_MS) {
    throw new GameError('PRICE_UNAVAILABLE', 'A fresh market price is not available yet. Try again shortly.', 503);
  }
  return parsed.data;
}

export class CoinbasePriceProvider implements PriceProvider {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now: () => number = Date.now) {}

  async getQuote(): Promise<Quote> {
    try {
      const response = await this.fetcher('https://api.exchange.coinbase.com/products/BTC-USD/ticker', {
        headers: { Accept: 'application/json', 'User-Agent': 'btc-minute/1.0' },
        signal: AbortSignal.timeout(5_000),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Price provider HTTP ${response.status}`);
      const ticker = tickerSchema.parse(await response.json());
      return validateFreshQuote({
        price: ticker.price,
        tradeId: String(ticker.trade_id),
        timestamp: ticker.time,
        receivedAt: new Date(this.now()).toISOString(),
        source: 'Coinbase',
      }, this.now());
    } catch (error) {
      if (error instanceof GameError) throw error;
      throw new GameError('PRICE_UNAVAILABLE', 'The market price is temporarily unavailable. Try again shortly.', 503);
    }
  }
}
