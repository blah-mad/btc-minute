import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAuth } from '../../src/auth/index.js';
import { GameError, type GameService } from '../../src/game/index.js';
import { createHttpHandler } from '../../src/server/http.js';

describe('HTTP game boundary', () => {
  const origin = 'https://btc.example.test';
  const getSession = vi.fn();
  const authHandler = vi.fn();
  const resolvePlayer = vi.fn();
  const getState = vi.fn();
  const placeGuess = vi.fn();
  const getLatestQuote = vi.fn();
  const handler = createHttpHandler(
    { handler: authHandler, api: { getSession } } as unknown as AppAuth,
    { resolvePlayer, getState, placeGuess, getLatestQuote } as unknown as GameService,
    origin,
  );
  const request = (path: string, body?: string, headers: Record<string, string> = {}) => new Request(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    body,
    headers: { origin, 'content-type': 'application/json', ...headers },
  });
  beforeEach(() => {
    vi.resetAllMocks();
    getSession.mockResolvedValue({ user: { id: 'authenticated-user' } });
    resolvePlayer.mockResolvedValue('owned-player');
    getState.mockResolvedValue({ playerId: 'owned-player', score: 0, activeGuess: null, lastResult: null });
    placeGuess.mockResolvedValue({ playerId: 'owned-player', score: 0, activeGuess: { id: 'accepted' } });
    getLatestQuote.mockResolvedValue({ price: '61000', source: 'Coinbase' });
  });

  it('requires an authenticated session before creating a guess', async () => {
    getSession.mockResolvedValue(null);
    const response = await handler(request('/api/guesses', JSON.stringify({ direction: 'up', requestId: randomUUID() })));
    expect(response.status).toBe(401);
    expect(placeGuess).not.toHaveBeenCalled();
    expect(resolvePlayer).not.toHaveBeenCalled();
  });

  it('uses the session owner, never a client-supplied player identifier', async () => {
    const requestId = randomUUID();
    const response = await handler(request('/api/guesses', JSON.stringify({ direction: 'down', requestId })));
    expect(response.status).toBe(200);
    expect(resolvePlayer).toHaveBeenCalledWith('authenticated-user');
    expect(placeGuess).toHaveBeenCalledWith('owned-player', 'down', requestId);
    const tampered = await handler(request('/api/guesses', JSON.stringify({ direction: 'up', requestId, playerId: 'another-player' })));
    expect(tampered.status).toBe(400);
    expect(placeGuess).toHaveBeenCalledTimes(1);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('does not accept score, price, time, or invalid direction from clients', async () => {
    for (const extra of [{ score: 100 }, { entryPrice: '1' }, { acceptedAt: '2000-01-01' }, { direction: 'sideways' }]) {
      const response = await handler(request('/api/guesses', JSON.stringify({ direction: 'up', requestId: randomUUID(), ...extra })));
      expect(response.status).toBe(400);
    }
    expect(placeGuess).not.toHaveBeenCalled();
  });

  it('rejects cross-origin and missing-origin mutations before auth or game code', async () => {
    const crossOrigin = await handler(request('/api/auth/sign-up/email', '{}', { origin: 'https://other.example.test' }));
    const missing = new Request(`${origin}/api/guesses`, { method: 'POST', body: '{}' });
    expect(crossOrigin.status).toBe(403);
    expect((await handler(missing)).status).toBe(403);
    expect(authHandler).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON, unsupported content type, and oversized bodies', async () => {
    expect((await handler(request('/api/guesses', '{broken'))).status).toBe(400);
    expect((await handler(request('/api/guesses', '{}', { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await handler(request('/api/guesses', JSON.stringify({ oversized: 'x'.repeat(2050) })))).status).toBe(413);
    expect(placeGuess).not.toHaveBeenCalled();
  });

  it('reports domain conflicts without leaking backend details', async () => {
    placeGuess.mockRejectedValue(new GameError('ACTIVE_GUESS', 'Your current guess must finish.'));
    const response = await handler(request('/api/guesses', JSON.stringify({ direction: 'up', requestId: randomUUID() })));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Your current guess must finish.', code: 'ACTIVE_GUESS' });
  });

  it('allows a public current-price read and communicates a provider outage', async () => {
    expect((await handler(request('/api/price'))).status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
    getLatestQuote.mockRejectedValue(new GameError('PRICE_UNAVAILABLE', 'Price temporarily unavailable.', 503));
    expect((await handler(request('/api/price'))).status).toBe(503);
  });
});
