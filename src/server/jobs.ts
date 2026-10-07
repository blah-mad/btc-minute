import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { DynamoDBStreamEvent, SQSEvent, SQSBatchResponse, DynamoDBBatchResponse } from 'aws-lambda';
import { z } from 'zod';
import { productionGame, requiredEnv } from './runtime.js';

const sqs = new SQSClient({});
const jobSchema = z.object({ playerId: z.string().min(1), guessId: z.string().min(1) });

async function enqueue(job: z.infer<typeof jobSchema>, at: number) {
  await sqs.send(new SendMessageCommand({
    QueueUrl: requiredEnv('RESOLUTION_QUEUE_URL'), MessageBody: JSON.stringify(job),
    DelaySeconds: Math.max(0, Math.min(900, Math.ceil((at - Date.now()) / 1000))),
  }));
}

export async function schedule(event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    const item = record.dynamodb?.NewImage;
    if (record.eventName !== 'INSERT' || item?.entity?.S !== 'GUESS' || item.status?.S !== 'pending') continue;
    try {
      const job = jobSchema.parse({ playerId: item.playerId?.S, guessId: item.id?.S });
      const deadline = Date.parse(item.eligibleAt?.S ?? '');
      if (!Number.isFinite(deadline)) throw new Error('Invalid deadline');
      await enqueue(job, deadline);
    } catch {
      if (record.dynamodb?.SequenceNumber) batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
    }
  }
  return { batchItemFailures };
}

export async function resolve(event: SQSEvent): Promise<SQSBatchResponse> {
  const game = productionGame();
  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const record of event.Records) {
    try {
      const job = jobSchema.parse(JSON.parse(record.body));
      const result = await game.settle(job.playerId, job.guessId);
      if (result.status === 'pending') {
        // A failed send fails this record, preserving its original message for retry.
        await enqueue(job, Date.parse(result.retryAt!));
      }
    } catch (error) {
      console.error('resolution_failed', { messageId: record.messageId, error: error instanceof Error ? error.name : 'UnknownError' });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
}
