import { createHash } from 'node:crypto';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/** A shared, atomic fixed-window counter. No Lambda-local rate-limit state. */
export function dynamoRateLimit(
  documentClient: DynamoDBDocumentClient,
  tableName: string,
  now: () => number = Date.now,
) {
  return {
    async consume(key: string, rule: { window: number; max: number }) {
      const windowMs = rule.window * 1_000;
      const currentTime = now();
      const bucket = Math.floor(currentTime / windowMs);
      const end = (bucket + 1) * windowMs;
      const digest = createHash('sha256').update(key).digest('hex');
      const result = await documentClient.send(new UpdateCommand({
        TableName: tableName,
        Key: { __ba_pk: `RATE#${digest}#${rule.window}#${bucket}`, __ba_sk: '#' },
        UpdateExpression: 'ADD #count :one SET #ttl = :ttl',
        ExpressionAttributeNames: { '#count': 'count', '#ttl': '__ba_ttl' },
        ExpressionAttributeValues: { ':one': 1, ':ttl': Math.ceil(end / 1_000) },
        ReturnValues: 'UPDATED_NEW',
      }));
      const allowed = Number(result.Attributes?.count) <= rule.max;
      return { allowed, retryAfter: allowed ? null : Math.max(1, Math.ceil((end - currentTime) / 1_000)) };
    },
  };
}
