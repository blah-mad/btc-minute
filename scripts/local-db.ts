import { CreateTableCommand, DescribeTableCommand, DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ensureSchema } from '@datar-platform/better-auth-dynamodb';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { delimiter } from 'node:path';
import { AUTH_LOOKUP_SLOTS, AUTH_TTL_ATTRIBUTE } from '../src/auth/index.js';

export const localEndpoint = 'http://127.0.0.1:8010';
export const localClient = new DynamoDBClient({ endpoint: localEndpoint, region: 'eu-central-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 1 });
export const localDocumentClient = DynamoDBDocumentClient.from(localClient, { marshallOptions: { removeUndefinedValues: true } });

export async function startLocalDatabase(): Promise<ChildProcess | undefined> {
  try { await localClient.send(new ListTablesCommand({})); return; } catch { /* Start loopback-only development database. */ }
  mkdirSync('.local/dynamodb', { recursive: true });
  if (!existsSync('.local/dynamodb/DynamoDBLocal.jar')) {
    console.log('Downloading the pinned DynamoDB Local archive (Java 17+ JDK required).');
    const response = await fetch('https://d1ni2b6xgvw0s0.cloudfront.net/v2.x/dynamodb_local_latest.tar.gz');
    if (!response.ok) throw new Error('DynamoDB Local download failed.');
    const archive = Buffer.from(await response.arrayBuffer());
    const hash = createHash('sha256').update(archive).digest('hex');
    if (hash !== 'f80bcec477f85f57e2c77f8d54aa6b672a8403fceff0c450560aee1cf6c21163') throw new Error('DynamoDB Local archive changed. Verify its official checksum before updating scripts/local-db.ts.');
    writeFileSync('.local/dynamodb/download.tar.gz', archive);
    execFileSync('tar', ['-xzf', '.local/dynamodb/download.tar.gz', '-C', '.local/dynamodb']);
  }
  const classpath = ['.local/dynamodb/DynamoDBLocal.jar', '.local/dynamodb/DynamoDBLocal_lib/*'].join(delimiter);
  const child = spawn('java', [
    '-Djava.library.path=.local/dynamodb/DynamoDBLocal_lib',
    '--class-path', classpath, 'scripts/DynamoDBLocal.java',
    '-sharedDb', '-dbPath', '.local/dynamodb', '-port', '8010', '-disableTelemetry',
    '-cors', 'http://127.0.0.1:5173,http://localhost:5173',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError: Error | undefined;
  let launchOutput = '';
  child.on('error', error => { launchError = error; });
  child.stderr?.on('data', chunk => { launchOutput = (launchOutput + String(chunk)).slice(-2_000); });
  for (let attempt = 0; attempt < 60; attempt++) {
    if (launchError || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Could not start loopback-only DynamoDB Local. A Java 17+ JDK is required. ${launchError?.message ?? launchOutput}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
    try { await localClient.send(new ListTablesCommand({})); return child; } catch { /* wait */ }
  }
  child.kill();
  throw new Error('DynamoDB Local did not start on port 8010.');
}

export async function setupTables(gameTable: string, authTable: string) {
  try { await localClient.send(new DescribeTableCommand({ TableName: gameTable })); }
  catch (error) {
    if (!(error instanceof Error) || error.name !== 'ResourceNotFoundException') throw error;
    await localClient.send(new CreateTableCommand({ TableName: gameTable, BillingMode: 'PAY_PER_REQUEST', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }, { AttributeName: 'sk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }] }));
  }
  await ensureSchema({ client: localClient, tableName: authTable, lookupSlots: AUTH_LOOKUP_SLOTS, ttlAttribute: AUTH_TTL_ATTRIBUTE });
}
