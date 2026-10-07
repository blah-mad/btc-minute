import { randomUUID } from 'node:crypto';
import type { Guess } from '../../src/shared/types.js';
import { assertIdle, assertPlayable, checkReceipt, GameError, type GameRepository, type LinkOptions, type PlayerRecord, type RequestReceipt } from '../../src/game/index.js';

/** Deterministic domain-test double; native DynamoDB transactions have a separate integration suite. */
export class MemoryGameRepository implements GameRepository {
  players = new Map<string, PlayerRecord>();
  guesses = new Map<string, Guess>();
  requests = new Map<string, RequestReceipt>();
  identities = new Map<string, { playerId: string; linkedTo?: string }>();

  async resolvePlayer(userId: string): Promise<string> {
    const identity = this.identities.get(userId);
    if (identity?.linkedTo) throw new GameError('SESSION_REPLACED', 'Session replaced.', 401);
    if (identity) return identity.playerId;
    const playerId = randomUUID();
    this.identities.set(userId, { playerId });
    this.players.set(playerId, { playerId, score: 0, roundCount: 0, version: 0 });
    return playerId;
  }
  async getPlayer(playerId: string) { return structuredClone(this.players.get(playerId) ?? null); }
  async getGuess(playerId: string, guessId: string) { return structuredClone(this.guesses.get(`${playerId}:${guessId}`) ?? null); }
  async getRequest(playerId: string, requestId: string) { return structuredClone(this.requests.get(`${playerId}:${requestId}`) ?? null); }
  async createGuess(guess: Guess, requestId: string) {
    const receipt = this.requests.get(`${guess.playerId}:${requestId}`);
    if (receipt) { checkReceipt(receipt, guess.direction); return; }
    const player = this.players.get(guess.playerId) ?? null;
    assertPlayable(player);
    if (player.activeGuessId) throw new GameError('ACTIVE_GUESS', 'Round pending.');
    this.guesses.set(`${guess.playerId}:${guess.id}`, structuredClone(guess));
    this.requests.set(`${guess.playerId}:${requestId}`, { guessId: guess.id, direction: guess.direction });
    player.activeGuessId = guess.id;
    player.roundCount++;
    player.version++;
  }
  async settleGuess(guess: Guess) {
    const current = this.guesses.get(`${guess.playerId}:${guess.id}`);
    if (current?.status === 'resolved') return false;
    const player = this.players.get(guess.playerId)!;
    if (player.activeGuessId !== guess.id) throw new Error('Active guess mismatch.');
    this.guesses.set(`${guess.playerId}:${guess.id}`, structuredClone(guess));
    player.score += guess.delta!;
    player.lastResultId = guess.id;
    delete player.activeGuessId;
    player.version++;
    return true;
  }
  async listPending() { return structuredClone([...this.guesses.values()].filter((guess) => guess.status === 'pending')); }
  async assertIdentityIdle(userId: string) {
    const identity = this.identities.get(userId);
    if (identity) assertIdle(this.players.get(identity.playerId) ?? null);
  }
  async linkGuest(sourceId: string, targetId: string, options: LinkOptions = {}) {
    const linked = this.identities.get(sourceId)?.linkedTo;
    if (linked === targetId) return this.resolvePlayer(targetId);
    if (linked) throw new GameError('SESSION_REPLACED', 'Session already linked.', 401);
    const sourcePlayer = this.players.get(await this.resolvePlayer(sourceId))!;
    const targetPlayer = this.players.get(await this.resolvePlayer(targetId))!;
    assertIdle(sourcePlayer); assertIdle(targetPlayer);
    const adopt = options.adoptGuest !== false && targetPlayer.roundCount === 0;
    const result = adopt ? sourcePlayer : targetPlayer;
    const retired = adopt ? targetPlayer : sourcePlayer;
    this.identities.set(sourceId, { playerId: sourcePlayer.playerId, linkedTo: targetId });
    this.identities.set(targetId, { playerId: result.playerId });
    retired.retiredTo = result.playerId;
    retired.version++;
    result.version++;
    return result.playerId;
  }
}
