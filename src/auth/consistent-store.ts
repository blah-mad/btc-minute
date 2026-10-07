import type { DynamoStore, StoreItem } from '@datar-platform/better-auth-dynamodb';

/**
 * DynamoDB GSIs are eventually consistent. Never authenticate a deleted or
 * changed row merely because its old projection is still present in an index.
 * The adapter's public getById method uses a strongly consistent table read.
 */
export function withConsistentIndexedReads(store: DynamoStore): DynamoStore {
  return {
    ...store,
    async queryIndex(request) {
      let result = await store.queryIndex(request);
      // A just-created session can reach the next request before its GSI entry.
      // Bound retries; callers may still need to retry a transient missing session.
      if (request.model === 'session' && request.index === 'by_token' && !request.cursor) {
        for (const delay of [25, 50, 100, 200]) {
          if (result.items.length > 0) break;
          await new Promise((resolve) => setTimeout(resolve, delay));
          result = await store.queryIndex(request);
        }
      }
      const current = await Promise.all(result.items.map((item) => store.getById(request.model, String(item.id))));
      return {
        ...result,
        items: current.filter((item): item is StoreItem => item !== null && Object.entries(request.key).every(([key, value]) => item[key] === value)),
      };
    },
  };
}
