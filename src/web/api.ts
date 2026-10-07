import type { ApiError, Direction, PlayerState, Quote } from '../shared/types';

export type PlayerSnapshot = PlayerState & { clientReceivedAt: number };

export class RequestError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'RequestError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { credentials: 'same-origin', ...init });
  } catch {
    throw new RequestError('Connection lost. Check your connection and try again.', 'NETWORK_ERROR', 0);
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body as Partial<ApiError> | null;
    throw new RequestError(
      error?.error || 'This request could not be completed. Please try again.',
      error?.code || 'REQUEST_FAILED',
      response.status,
    );
  }
  return body as T;
}

export async function getPlayer(): Promise<PlayerSnapshot> {
  const state = await request<PlayerState>('/api/player');
  return { ...state, clientReceivedAt: Date.now() };
}

export function getQuote(): Promise<Quote> {
  return request<Quote>('/api/price');
}

export async function makeGuess(direction: Direction): Promise<PlayerSnapshot> {
  const state = await request<PlayerState>('/api/guesses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction, requestId: crypto.randomUUID() }),
  });
  return { ...state, clientReceivedAt: Date.now() };
}
