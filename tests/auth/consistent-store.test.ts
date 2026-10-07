import { describe, expect, it, vi } from 'vitest';
import type { DynamoStore } from '@datar-platform/better-auth-dynamodb';
import { withConsistentIndexedReads } from '../../src/auth/consistent-store.js';

describe('auth indexed-read consistency', () => {
  it('rejects a revoked session that is still present in a stale index projection', async () => {
    const store = {
      queryIndex: vi.fn().mockResolvedValue({ items: [{ id: 'revoked', token: 'old' }] }),
      getById: vi.fn().mockResolvedValue(null),
    } as unknown as DynamoStore;
    const result = await withConsistentIndexedReads(store).queryIndex({ model: 'session', index: 'by_token', key: { token: 'old' } });
    expect(result.items).toEqual([]);
    expect(store.getById).toHaveBeenCalledWith('session', 'revoked');
  });

  it('rejects a row whose indexed key has since changed', async () => {
    const store = {
      queryIndex: vi.fn().mockResolvedValue({ items: [{ id: 'user', email: 'old@example.test' }] }),
      getById: vi.fn().mockResolvedValue({ id: 'user', email: 'new@example.test' }),
    } as unknown as DynamoStore;
    const result = await withConsistentIndexedReads(store).queryIndex({ model: 'user', index: 'by_email', key: { email: 'old@example.test' } });
    expect(result.items).toEqual([]);
  });

  it('retries a session token lookup while a new index entry becomes visible', async () => {
    const session = { id: 'session', token: 'new' };
    const store = {
      queryIndex: vi.fn().mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: [session] }),
      getById: vi.fn().mockResolvedValue(session),
    } as unknown as DynamoStore;
    const result = await withConsistentIndexedReads(store).queryIndex({ model: 'session', index: 'by_token', key: { token: 'new' } });
    expect(result.items).toEqual([session]);
    expect(store.queryIndex).toHaveBeenCalledTimes(2);
  });
});
