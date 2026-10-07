import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { CoinbasePriceProvider, DynamoGameRepository, GameService } from '../game/index.js';
import { createAuth } from '../auth/index.js';
import { createHttpHandler } from './http.js';

export function requiredEnv(key: string) {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
export function productionGame() {
  return new GameService(new DynamoGameRepository(documentClient, requiredEnv('GAME_TABLE')), new CoinbasePriceProvider());
}

let httpRuntime: ReturnType<typeof loadRuntime> | undefined;
async function loadRuntime() {
  const secrets = new SecretsManagerClient({});
  const [authSecret, originSecret, originParameter] = await Promise.all([
    secrets.send(new GetSecretValueCommand({ SecretId: requiredEnv('AUTH_SECRET_ARN') })),
    secrets.send(new GetSecretValueCommand({ SecretId: requiredEnv('ORIGIN_SECRET_ARN') })),
    new SSMClient({}).send(new GetParameterCommand({ Name: requiredEnv('APP_ORIGIN_PARAMETER') })),
  ]);
  if (!authSecret.SecretString || !originSecret.SecretString || !originParameter.Parameter?.Value) throw new Error('Application configuration is incomplete.');
  const origin = originParameter.Parameter.Value;
  const game = productionGame();
  const auth = createAuth({ documentClient, tableName: requiredEnv('AUTH_TABLE'), secret: authSecret.SecretString, baseURL: origin, identityStore: game });
  return { origin, originSecret: originSecret.SecretString, handle: createHttpHandler(auth, game, origin) };
}
export function getHttpRuntime() {
  return httpRuntime ??= loadRuntime().catch(error => { httpRuntime = undefined; throw error; });
}
