import { randomUUID } from 'node:crypto';
import { GetCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import type { Guess } from '../shared/types.js';
import { assertIdle, assertPlayable, checkReceipt, GameError, type GameRepository, type LinkOptions, type PlayerRecord, type RequestReceipt } from './contracts.js';

type Identity = { playerId: string; linkedTo?: string };
type TransactionItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];
const playerKey = (playerId: string) => ({ pk: `PLAYER#${playerId}`, sk: 'PROFILE' });
const guessKey = (playerId: string, guessId: string) => ({ pk: `PLAYER#${playerId}`, sk: `GUESS#${guessId}` });
const identityKey = (userId: string) => ({ pk: `IDENTITY#${userId}`, sk: 'MAP' });
const requestKey = (playerId: string, requestId: string) => ({ pk: `PLAYER#${playerId}`, sk: `REQUEST#${requestId}` });

function conditionalConflict(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'ConditionalCheckFailedException' || error.name === 'TransactionConflictException') return true;
  if (error.name !== 'TransactionCanceledException') return false;
  const reasons = (error as Error & { CancellationReasons?: { Code?: string }[] }).CancellationReasons;
  return !!reasons?.some((reason) => reason.Code === 'ConditionalCheckFailed' || reason.Code === 'TransactionConflict')
    && reasons.every((reason) => !reason.Code || ['None', 'ConditionalCheckFailed', 'TransactionConflict'].includes(reason.Code));
}

function record<T>(item: Record<string, unknown> | undefined): T | null {
  if (!item) return null;
  const { pk: _pk, sk: _sk, entity: _entity, ...data } = item;
  return data as T;
}

/** All client construction is external, so local tests cannot accidentally use an AWS account. */
export class DynamoGameRepository implements GameRepository {
  constructor(private readonly db: DynamoDBDocumentClient, private readonly tableName: string) {}

  private async read<T>(Key: { pk: string; sk: string }): Promise<T | null> {
    const result = await this.db.send(new GetCommand({ TableName: this.tableName, Key, ConsistentRead: true }));
    return record<T>(result.Item);
  }
  private identity(userId: string): Promise<Identity | null> { return this.read<Identity>(identityKey(userId)); }
  getPlayer(playerId: string): Promise<PlayerRecord | null> { return this.read<PlayerRecord>(playerKey(playerId)); }
  getGuess(playerId: string, guessId: string): Promise<Guess | null> { return this.read<Guess>(guessKey(playerId, guessId)); }
  getRequest(playerId: string, requestId: string): Promise<RequestReceipt | null> { return this.read<RequestReceipt>(requestKey(playerId, requestId)); }

  async resolvePlayer(userId: string): Promise<string> {
    if (!userId || userId.length > 200) throw new GameError('INVALID_IDENTITY', 'A valid session is required.', 401);
    for (let attempt = 0; attempt < 6; attempt++) {
      const identity = await this.identity(userId);
      if (identity?.linkedTo) throw new GameError('SESSION_REPLACED', 'Your account changed. Refresh to continue.', 401);
      if (identity) return identity.playerId;
      const playerId = randomUUID();
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: this.tableName, Item: { ...identityKey(userId), entity: 'IDENTITY', playerId }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: this.tableName, Item: { ...playerKey(playerId), entity: 'PLAYER', playerId, score: 0, roundCount: 0, version: 0 }, ConditionExpression: 'attribute_not_exists(pk)' } },
        ] }));
        return playerId;
      } catch (error) {
        if (!conditionalConflict(error)) throw error;
        await this.backoff(attempt);
      }
    }
    throw this.busy();
  }

  async assertIdentityIdle(userId: string): Promise<void> {
    const identity = await this.identity(userId);
    if (identity?.linkedTo) throw new GameError('SESSION_REPLACED', 'Your account changed. Refresh to continue.', 401);
    if (identity) assertIdle(await this.getPlayer(identity.playerId));
  }

  async createGuess(guess: Guess, requestId: string): Promise<void> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const receipt = await this.getRequest(guess.playerId, requestId);
      if (receipt) { checkReceipt(receipt, guess.direction); return; }
      const player = await this.getPlayer(guess.playerId);
      assertPlayable(player);
      if (player.activeGuessId) {
        const committed = await this.getRequest(guess.playerId, requestId);
        if (committed) { checkReceipt(committed, guess.direction); return; }
        throw new GameError('ACTIVE_GUESS', 'Your current guess must finish before you make another.');
      }
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: this.tableName, Item: { ...guessKey(guess.playerId, guess.id), entity: 'GUESS', ...guess }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Put: { TableName: this.tableName, Item: { ...requestKey(guess.playerId, requestId), entity: 'REQUEST', guessId: guess.id, direction: guess.direction }, ConditionExpression: 'attribute_not_exists(pk)' } },
          { Update: {
            TableName: this.tableName, Key: playerKey(guess.playerId),
            UpdateExpression: 'SET activeGuessId = :id, #version = #version + :one, roundCount = roundCount + :one',
            ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(activeGuessId) AND attribute_not_exists(retiredTo)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':id': guess.id, ':one': 1 },
          } },
        ] }));
        return;
      } catch (error) {
        if (!conditionalConflict(error)) throw error;
        await this.backoff(attempt);
      }
    }
    throw this.busy();
  }

  async settleGuess(guess: Guess): Promise<boolean> {
    if (guess.status !== 'resolved' || (guess.delta !== 1 && guess.delta !== -1)) throw new Error('A completed settlement is required.');
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: [
          { Put: {
            TableName: this.tableName, Item: { ...guessKey(guess.playerId, guess.id), entity: 'GUESS', ...guess },
            ConditionExpression: '#status = :pending', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':pending': 'pending' },
          } },
          { Update: {
            TableName: this.tableName, Key: playerKey(guess.playerId),
            UpdateExpression: 'SET score = score + :delta, lastResultId = :id, #version = #version + :one REMOVE activeGuessId',
            ConditionExpression: 'activeGuessId = :id AND attribute_not_exists(retiredTo)',
            ExpressionAttributeNames: { '#version': 'version' },
            ExpressionAttributeValues: { ':delta': guess.delta, ':id': guess.id, ':one': 1 },
          } },
        ] }));
        return true;
      } catch (error) {
        if (!conditionalConflict(error)) throw error;
        const existing = await this.getGuess(guess.playerId, guess.id);
        if (existing?.status === 'resolved') return false;
        if (!existing) throw new GameError('GUESS_NOT_FOUND', 'Guess not found.', 404);
        await this.backoff(attempt);
      }
    }
    throw this.busy();
  }

  async linkGuest(anonymousUserId: string, targetUserId: string, options: LinkOptions = {}): Promise<string> {
    if (anonymousUserId === targetUserId) return this.resolvePlayer(targetUserId);
    for (let attempt = 0; attempt < 6; attempt++) {
      const sourceIdentity = await this.identity(anonymousUserId);
      if (sourceIdentity?.linkedTo) {
        if (sourceIdentity.linkedTo !== targetUserId) throw new GameError('SESSION_REPLACED', 'This guest session has already been linked.', 401);
        return this.resolvePlayer(targetUserId);
      }
      // Creating an empty target mapping first is harmless. The subsequent
      // transaction transfers ownership and retires the unused profile together.
      const sourceId = sourceIdentity?.playerId ?? await this.resolvePlayer(anonymousUserId);
      const targetId = await this.resolvePlayer(targetUserId);
      const [source, target] = await Promise.all([this.getPlayer(sourceId), this.getPlayer(targetId)]);
      assertPlayable(source); assertPlayable(target);
      assertIdle(source); assertIdle(target);
      const adopt = options.adoptGuest !== false && target.roundCount === 0;
      const resultId = adopt ? sourceId : targetId;
      const items: TransactionItem[] = [
        { Update: {
          TableName: this.tableName, Key: identityKey(anonymousUserId),
          UpdateExpression: 'SET linkedTo = :target',
          ConditionExpression: 'playerId = :source AND attribute_not_exists(linkedTo)',
          ExpressionAttributeValues: { ':target': targetUserId, ':source': sourceId },
        } },
        { Update: {
          TableName: this.tableName, Key: identityKey(targetUserId),
          UpdateExpression: 'SET playerId = :result',
          ConditionExpression: 'playerId = :old AND attribute_not_exists(linkedTo)',
          ExpressionAttributeValues: { ':result': resultId, ':old': targetId },
        } },
      ];
      for (const player of sourceId === targetId ? [source] : [source, target]) {
        const retired = player.playerId !== resultId;
        items.push({ Update: {
          TableName: this.tableName, Key: playerKey(player.playerId),
          UpdateExpression: retired ? 'SET #version = #version + :one, retiredTo = :result' : 'SET #version = #version + :one',
          ConditionExpression: '#version = :version AND attribute_not_exists(activeGuessId) AND attribute_not_exists(retiredTo)',
          ExpressionAttributeNames: { '#version': 'version' },
          ExpressionAttributeValues: { ':one': 1, ':version': player.version, ...(retired ? { ':result': resultId } : {}) },
        } });
      }
      try {
        await this.db.send(new TransactWriteCommand({ TransactItems: items }));
        return resultId;
      } catch (error) {
        if (!conditionalConflict(error)) throw error;
        await this.backoff(attempt);
      }
    }
    throw this.busy();
  }

  async listPending(): Promise<Guess[]> {
    const guesses: Guess[] = [];
    let ExclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.db.send(new ScanCommand({
        TableName: this.tableName, ConsistentRead: true, ExclusiveStartKey,
        FilterExpression: '#entity = :guess AND #status = :pending',
        ExpressionAttributeNames: { '#entity': 'entity', '#status': 'status' },
        ExpressionAttributeValues: { ':guess': 'GUESS', ':pending': 'pending' },
      }));
      guesses.push(...(response.Items ?? []).map((item) => record<Guess>(item)!));
      ExclusiveStartKey = response.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return guesses;
  }

  private busy(): GameError { return new GameError('CONCURRENT_UPDATE', 'Your player state changed. Please try again.', 409); }
  private async backoff(attempt: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, Math.min(10 * 2 ** attempt + Math.random() * 10, 200)));
  }
}
