import type { Guess } from '../shared/types';

export function serverNow(clientNow: number, snapshot?: { serverTime: string; clientReceivedAt: number }) {
  if (!snapshot) return clientNow;
  const serverTime = Date.parse(snapshot.serverTime);
  return Number.isFinite(serverTime) ? clientNow + serverTime - snapshot.clientReceivedAt : clientNow;
}

export function roundClock(guess: Pick<Guess, 'acceptedAt' | 'eligibleAt'> | null | undefined, now: number) {
  if (!guess) return { remaining: 60, elapsed: 0 };
  const eligibleAt = Date.parse(guess.eligibleAt);
  const acceptedAt = Date.parse(guess.acceptedAt);
  if (!Number.isFinite(eligibleAt) || !Number.isFinite(acceptedAt)) return { remaining: 0, elapsed: 0 };
  return {
    remaining: Math.min(60, Math.max(0, Math.ceil((eligibleAt - now) / 1_000))),
    elapsed: Math.min(1, Math.max(0, (now - acceptedAt) / 60_000)),
  };
}

export function quoteAgeMs(timestamp: string | undefined, now: number) {
  const time = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(time) && time <= now + 5_000 ? Math.max(0, now - time) : Infinity;
}

type RecoveryState = {
  busy: boolean;
  hasError: boolean;
  knownSession: boolean;
  attempts: number;
  exhausted: boolean;
  guestAttempted: boolean;
};

export type RecoveryStep = { kind: 'none' | 'createGuest' | 'chooseGuest' } | { kind: 'retry'; delay: number };

/** A known identity is never replaced by an automatic guest sign-in. */
export function sessionRecovery(state: RecoveryState): RecoveryStep {
  if (state.busy || state.hasError) return { kind: 'none' };
  if (state.knownSession) {
    if (state.exhausted) return { kind: 'none' };
    if (state.attempts >= 3) return { kind: 'chooseGuest' };
    return { kind: 'retry', delay: [250, 500, 1_000][Math.max(0, state.attempts)] };
  }
  return { kind: state.guestAttempted ? 'none' : 'createGuest' };
}
