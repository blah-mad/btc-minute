import { describe, expect, it } from 'vitest';
import { quoteAgeMs, roundClock, serverNow, sessionRecovery } from '../../src/web/state';

describe('the visible game clock', () => {
  const accepted = Date.parse('2026-10-08T12:00:00.000Z');
  const guess = { acceptedAt: new Date(accepted).toISOString(), eligibleAt: new Date(accepted + 60_000).toISOString() };

  it.each([7 * 3_600_000, -3 * 3_600_000])('uses server time when the browser is skewed by %ims', (skew) => {
    const receivedAt = accepted + skew;
    const now = serverNow(receivedAt + 10_000, { serverTime: guess.acceptedAt, clientReceivedAt: receivedAt });
    expect(roundClock(guess, now)).toEqual({ remaining: 50, elapsed: 1 / 6 });
    expect(quoteAgeMs(new Date(accepted + 9_000).toISOString(), now)).toBe(1_000);
  });

  it('does not show zero before the full minute, even at its last millisecond', () => {
    expect(roundClock(guess, accepted + 59_999).remaining).toBe(1);
    expect(roundClock(guess, accepted + 60_000)).toEqual({ remaining: 0, elapsed: 1 });
  });

  it('clamps a restored overdue round to the waiting state', () => {
    expect(roundClock(guess, accepted + 600_000)).toEqual({ remaining: 0, elapsed: 1 });
  });

  it('rejects missing, invalid, or implausibly future price timestamps', () => {
    expect(quoteAgeMs(undefined, accepted)).toBe(Infinity);
    expect(quoteAgeMs('not-a-time', accepted)).toBe(Infinity);
    expect(quoteAgeMs(new Date(accepted + 60_000).toISOString(), accepted)).toBe(Infinity);
  });
});

describe('anonymous session recovery', () => {
  const state = { busy: false, hasError: false, knownSession: false, attempts: 0, exhausted: false, guestAttempted: false };

  it('creates a guest only for a new browser after the session check has completed', () => {
    expect(sessionRecovery(state).kind).toBe('createGuest');
    expect(sessionRecovery({ ...state, busy: true }).kind).toBe('none');
    expect(sessionRecovery({ ...state, hasError: true }).kind).toBe('none');
    expect(sessionRecovery({ ...state, guestAttempted: true }).kind).toBe('none');
  });

  it.each([0, 1, 2, 3, 4, 100])('never replaces an established identity after %i failed restores', (attempts) => {
    expect(sessionRecovery({ ...state, knownSession: true, attempts }).kind).not.toBe('createGuest');
  });

  it('uses bounded retries and then waits for the player to choose', () => {
    expect([0, 1, 2].map((attempts) => sessionRecovery({ ...state, knownSession: true, attempts }))).toEqual([
      { kind: 'retry', delay: 250 }, { kind: 'retry', delay: 500 }, { kind: 'retry', delay: 1_000 },
    ]);
    expect(sessionRecovery({ ...state, knownSession: true, attempts: 3 })).toEqual({ kind: 'chooseGuest' });
    expect(sessionRecovery({ ...state, knownSession: true, exhausted: true })).toEqual({ kind: 'none' });
  });
});
