import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DynamoDBStreamEvent, SQSEvent } from 'aws-lambda';

const mocks = vi.hoisted(() => ({ send: vi.fn(), settle: vi.fn() }));
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class { send = mocks.send; },
  SendMessageCommand: class { constructor(public input: Record<string, unknown>) {} },
}));
vi.mock('../../src/server/runtime.js', () => ({
  productionGame: () => ({ settle: mocks.settle }),
  requiredEnv: () => 'https://sqs.example.test/local-test-queue',
}));
import { resolve, schedule } from '../../src/server/jobs.js';

const now = Date.parse('2026-10-08T12:00:00.000Z');
function streamRecord(sequence: string, deadline = now + 60_000, entity = 'GUESS', eventName = 'INSERT', status = 'pending') {
  return { eventName, dynamodb: { SequenceNumber: sequence, NewImage: {
    entity: { S: entity }, status: { S: status }, playerId: { S: 'player-1' }, id: { S: `guess-${sequence}` }, eligibleAt: { S: new Date(deadline).toISOString() },
  } } };
}
const stream = (...records: ReturnType<typeof streamRecord>[]) => ({ Records: records }) as unknown as DynamoDBStreamEvent;
const queue = (...bodies: string[]) => ({ Records: bodies.map((body, index) => ({ messageId: `message-${index}`, body })) }) as SQSEvent;
const body = JSON.stringify({ playerId: 'player-1', guessId: 'guess-1' });

describe('durable guess scheduling', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mocks.send.mockResolvedValue({ MessageId: 'sent' });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('only schedules new pending GUESS records, not settlement modifications or player writes', async () => {
    const response = await schedule(stream(
      streamRecord('1'), streamRecord('2', now, 'GUESS', 'MODIFY', 'resolved'), streamRecord('3', now, 'PLAYER'),
    ));
    expect(response).toEqual({ batchItemFailures: [] });
    expect(mocks.send).toHaveBeenCalledTimes(1);
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({ DelaySeconds: 60, MessageBody: JSON.stringify({ playerId: 'player-1', guessId: 'guess-1' }) });
  });

  it('rounds the delay up and schedules overdue stream records immediately', async () => {
    await schedule(stream(streamRecord('1', now + 59_501), streamRecord('2', now - 60_000)));
    expect(mocks.send.mock.calls.map(([command]) => command.input.DelaySeconds)).toEqual([60, 0]);
  });

  it('reports a failed stream send by sequence number so Lambda retries instead of losing the guess', async () => {
    mocks.send.mockRejectedValueOnce(new Error('SQS unavailable'));
    const result = await schedule(stream(streamRecord('10'), streamRecord('11')));
    expect(result).toEqual({ batchItemFailures: [{ itemIdentifier: '10' }] });
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it('retries malformed pending records instead of acknowledging them', async () => {
    const invalid = streamRecord('12');
    invalid.dynamodb.NewImage.eligibleAt.S = 'not-a-date';
    expect(await schedule(stream(invalid))).toEqual({ batchItemFailures: [{ itemIdentifier: '12' }] });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('reschedules an equal or unavailable price and acknowledges only after the new message is durable', async () => {
    mocks.settle.mockResolvedValue({ status: 'pending', retryAt: new Date(now + 5_000).toISOString() });
    expect(await resolve(queue(body))).toEqual({ batchItemFailures: [] });
    expect(mocks.settle).toHaveBeenCalledWith('player-1', 'guess-1');
    expect(mocks.send.mock.calls[0][0].input).toMatchObject({ DelaySeconds: 5, MessageBody: body });
  });

  it('keeps the original SQS message when enqueuing its replacement fails', async () => {
    mocks.settle.mockResolvedValue({ status: 'pending', retryAt: new Date(now + 5_000).toISOString() });
    mocks.send.mockRejectedValue(new Error('SQS unavailable'));
    expect(await resolve(queue(body))).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-0' }] });
  });

  it.each(['resolved', 'already-resolved'])('acknowledges %s without scheduling another worker', async (status) => {
    mocks.settle.mockResolvedValue({ status });
    expect(await resolve(queue(body))).toEqual({ batchItemFailures: [] });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('isolates a database error or malformed body to the affected SQS record', async () => {
    mocks.settle.mockRejectedValueOnce(new Error('DynamoDB unavailable')).mockResolvedValueOnce({ status: 'resolved' });
    expect(await resolve(queue(body, '{broken', body))).toEqual({ batchItemFailures: [{ itemIdentifier: 'message-0' }, { itemIdentifier: 'message-1' }] });
    expect(mocks.settle).toHaveBeenCalledTimes(2);
  });
});
