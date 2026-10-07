import type { Direction, Guess, Quote } from '../shared/types.js';

export class GameError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 409) {
    super(message);
    this.name = 'GameError';
  }
}

export interface PlayerRecord {
  playerId: string;
  score: number;
  roundCount: number;
  version: number;
  activeGuessId?: string;
  lastResultId?: string;
  retiredTo?: string;
}

export interface RequestReceipt {
  guessId: string;
  direction: Direction;
}

export interface LinkOptions { adoptGuest?: boolean }

export interface GameRepository {
  resolvePlayer(userId: string): Promise<string>;
  assertIdentityIdle(userId: string): Promise<void>;
  linkGuest(anonymousUserId: string, targetUserId: string, options?: LinkOptions): Promise<string>;
  getPlayer(playerId: string): Promise<PlayerRecord | null>;
  getGuess(playerId: string, guessId: string): Promise<Guess | null>;
  getRequest(playerId: string, requestId: string): Promise<RequestReceipt | null>;
  createGuess(guess: Guess, requestId: string): Promise<void>;
  settleGuess(guess: Guess): Promise<boolean>;
  /** Development scheduler / explicit operational recovery, not a production request path. */
  listPending(): Promise<Guess[]>;
}

export interface PriceProvider { getQuote(): Promise<Quote> }

export function assertPlayable(player: PlayerRecord | null): asserts player is PlayerRecord {
  if (!player) throw new GameError('PLAYER_NOT_FOUND', 'Player not found.', 404);
  if (player.retiredTo) throw new GameError('PLAYER_REPLACED', 'Your account changed. Refresh to continue.');
}

export function assertIdle(player: PlayerRecord | null): void {
  if (player?.activeGuessId) throw new GameError('ACTIVE_GUESS', 'Finish your current round before switching accounts.');
}

export function checkReceipt(receipt: RequestReceipt, direction: Direction): void {
  if (receipt.direction !== direction) {
    throw new GameError('IDEMPOTENCY_CONFLICT', 'This request ID has already been used for a different guess.');
  }
}
