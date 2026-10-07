import { z } from 'zod';
import type { AppAuth } from '../auth/index.js';
import { GameError, type GameService } from '../game/index.js';

const guessInput = z.object({ direction: z.enum(['up', 'down']), requestId: z.uuid() }).strict();
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store' } });

export function createHttpHandler(auth: AppAuth, game: GameService, origin: string) {
  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    try {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        // All browser mutations are same-origin, including guest creation.
        if (request.headers.get('origin') !== origin) return json({ error: 'Request origin is not allowed.', code: 'FORBIDDEN' }, 403);
      }
      if (path.startsWith('/api/auth/')) return await auth.handler(request);
      if (path === '/api/health' && request.method === 'GET') return json({ status: 'ok' });
      if (path === '/api/price' && request.method === 'GET') return json(await game.getLatestQuote());
      const session = await auth.api.getSession({ headers: request.headers });
      if (!session) return json({ error: 'Start a session to play.', code: 'UNAUTHORIZED' }, 401);
      const playerId = await game.resolvePlayer(session.user.id);
      if (path === '/api/player' && request.method === 'GET') return json(await game.getState(playerId));
      if (path === '/api/guesses' && request.method === 'POST') {
        if (!request.headers.get('content-type')?.includes('application/json')) return json({ error: 'A JSON request is required.', code: 'INVALID_REQUEST' }, 415);
        const text = await request.text();
        if (text.length > 2048) return json({ error: 'Request is too large.', code: 'INVALID_REQUEST' }, 413);
        let body: unknown;
        try { body = JSON.parse(text); } catch { return json({ error: 'Invalid JSON.', code: 'INVALID_REQUEST' }, 400); }
        const parsed = guessInput.safeParse(body);
        if (!parsed.success) return json({ error: 'Choose up or down and provide a request ID.', code: 'INVALID_GUESS' }, 400);
        return json(await game.placeGuess(playerId, parsed.data.direction, parsed.data.requestId));
      }
      return json({ error: 'Route not found.', code: 'NOT_FOUND' }, 404);
    } catch (error) {
      if (error instanceof GameError) return json({ error: error.message, code: error.code }, error.status);
      console.error('request_failed', { path, error: error instanceof Error ? error.name : 'UnknownError' });
      return json({ error: 'Something went wrong. Try again shortly.', code: 'INTERNAL_ERROR' }, 500);
    }
  };
}
