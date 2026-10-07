import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { z } from 'zod';
import type { Direction, Guess, PlayerState, Quote } from '../shared/types.js';
import { assertPlayable, checkReceipt, GameError, type GameRepository, type LinkOptions, type PriceProvider } from './contracts.js';
import { validateFreshQuote } from './price.js';

export const ROUND_DURATION_MS = 60_000;
export const PRICE_RETRY_MS = 5_000;

export type SettlementResult = {
  status: 'pending' | 'resolved' | 'already-resolved';
  state: PlayerState;
  retryAt?: string;
  reason?: 'too-early' | 'unchanged' | 'price-unavailable' | 'pre-deadline-quote';
};

const submissionSchema = z.object({ direction: z.enum(['up', 'down']), requestId: z.uuid() });

export class GameService {
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(private readonly repository: GameRepository, private readonly prices: PriceProvider, options: { now?: () => number; uuid?: () => string } = {}) {
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
  }

  resolvePlayer(userId: string): Promise<string> { return this.repository.resolvePlayer(userId); }
  assertIdentityIdle(userId: string): Promise<void> { return this.repository.assertIdentityIdle(userId); }
  linkGuest(anonymousUserId: string, targetUserId: string, options?: LinkOptions): Promise<string> {
    return this.repository.linkGuest(anonymousUserId, targetUserId, options);
  }
  listPending(): Promise<Guess[]> { return this.repository.listPending(); }

  async getLatestQuote(): Promise<Quote> {
    try {
      return validateFreshQuote(await this.prices.getQuote(), this.now());
    } catch (error) {
      if (error instanceof GameError) throw error;
      throw new GameError('PRICE_UNAVAILABLE', 'The market price is temporarily unavailable. Try again shortly.', 503);
    }
  }

  async getState(playerId: string): Promise<PlayerState> {
    return this.readState(playerId, false);
  }

  private async readState(playerId: string, allowRetired: boolean): Promise<PlayerState> {
    // A settlement may run between reads. Retry if the profile changed, so the
    // score and active/result pointers always represent the same profile version.
    for (let attempt = 0; attempt < 5; attempt++) {
      const player = await this.repository.getPlayer(playerId);
      if (!player) throw new GameError('PLAYER_NOT_FOUND', 'Player not found.', 404);
      if (!allowRetired) assertPlayable(player);
      const [activeGuess, lastResult] = await Promise.all([
        player.activeGuessId ? this.repository.getGuess(playerId, player.activeGuessId) : null,
        player.lastResultId ? this.repository.getGuess(playerId, player.lastResultId) : null,
      ]);
      const current = await this.repository.getPlayer(playerId);
      if (!current) throw new GameError('PLAYER_NOT_FOUND', 'Player not found.', 404);
      if (!allowRetired) assertPlayable(current);
      if (current.version !== player.version) continue;
      if ((player.activeGuessId && !activeGuess) || (player.lastResultId && !lastResult)) {
        throw new GameError('STATE_UNAVAILABLE', 'Player state is temporarily unavailable.', 503);
      }
      return { playerId, score: player.score, activeGuess, lastResult, serverTime: new Date(this.now()).toISOString() };
    }
    throw new GameError('STATE_UNAVAILABLE', 'Player state changed. Please try again.', 503);
  }

  async placeGuess(playerId: string, direction: Direction, requestId: string): Promise<PlayerState> {
    if (!submissionSchema.safeParse({ direction, requestId }).success) {
      throw new GameError('INVALID_GUESS', 'Choose up or down and provide a UUID request ID.', 400);
    }
    const receipt = await this.repository.getRequest(playerId, requestId);
    if (receipt) {
      checkReceipt(receipt, direction);
      return this.getState(playerId);
    }
    const player = await this.repository.getPlayer(playerId);
    assertPlayable(player);
    if (player.activeGuessId) {
      // A parallel retry may have committed after the first receipt read.
      const committed = await this.repository.getRequest(playerId, requestId);
      if (committed) { checkReceipt(committed, direction); return this.getState(playerId); }
      throw new GameError('ACTIVE_GUESS', 'Your current guess must finish before you make another.');
    }
    const quote = await this.getLatestQuote();
    const acceptedAt = this.now();
    validateFreshQuote(quote, acceptedAt);
    await this.repository.createGuess({
      id: this.uuid(), playerId, direction,
      entryPrice: quote.price, entryTradeId: quote.tradeId, entryPriceAt: quote.timestamp,
      acceptedAt: new Date(acceptedAt).toISOString(),
      eligibleAt: new Date(acceptedAt + ROUND_DURATION_MS).toISOString(), status: 'pending',
    }, requestId);
    return this.getState(playerId);
  }

  async settle(playerId: string, guessId: string): Promise<SettlementResult> {
    const guess = await this.repository.getGuess(playerId, guessId);
    if (!guess) throw new GameError('GUESS_NOT_FOUND', 'Guess not found.', 404);
    // A guest profile can be retired after settlement. A delayed duplicate job
    // must still acknowledge its immutable result, without reviving that player.
    if (guess.status === 'resolved') return { status: 'already-resolved', state: await this.readState(playerId, true) };
    const deadline = Date.parse(guess.eligibleAt);
    if (this.now() < deadline) return this.pending(playerId, 'too-early', deadline);
    let quote: Quote;
    try {
      quote = await this.getLatestQuote();
    } catch (error) {
      if (!(error instanceof GameError) || error.code !== 'PRICE_UNAVAILABLE') throw error;
      return this.pending(playerId, 'price-unavailable');
    }
    if (Date.parse(quote.timestamp) < deadline) return this.pending(playerId, 'pre-deadline-quote');
    const comparison = new Decimal(quote.price).comparedTo(guess.entryPrice);
    if (comparison === 0) return this.pending(playerId, 'unchanged');
    const correct = guess.direction === 'up' ? comparison > 0 : comparison < 0;
    const settled = await this.repository.settleGuess({
      ...guess, status: 'resolved', settlementPrice: quote.price,
      settlementTradeId: quote.tradeId, settlementPriceAt: quote.timestamp,
      resolvedAt: new Date(this.now()).toISOString(), delta: correct ? 1 : -1,
    });
    return { status: settled ? 'resolved' : 'already-resolved', state: await this.readState(playerId, true) };
  }

  private async pending(playerId: string, reason: SettlementResult['reason'], retryAt = this.now() + PRICE_RETRY_MS): Promise<SettlementResult> {
    const state = await this.readState(playerId, true);
    // Another worker may have settled while this worker fetched the quote.
    if (!state.activeGuess) return { status: 'already-resolved', state };
    return { status: 'pending', reason, retryAt: new Date(retryAt).toISOString(), state };
  }
}
