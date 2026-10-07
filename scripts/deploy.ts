import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { fromIni } from '@aws-sdk/credential-providers';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const [command, ...args] = process.argv.slice(2);
const option = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const profile = option('--profile');
const account = option('--account');
const region = option('--region') ?? 'eu-central-1';
const ci = args.includes('--ci') && process.env.GITHUB_ACTIONS === 'true';
if (!['deploy', 'bootstrap', 'destroy'].includes(command) || !account || !/^\d{12}$/.test(account) || account === '111111111111' || (!ci && (!profile || profile === 'default'))) {
  console.error('Provide an explicit non-default profile and expected account: npm run deploy -- --profile <new-profile> --account <12-digit-account> [--region eu-central-1]. No AWS calls were made.');
  process.exit(1);
}
if (ci && (process.env.AWS_PROFILE || !process.env.AWS_SESSION_TOKEN)) throw new Error('CI deployments require temporary OIDC credentials, not a local profile.');
const credentials = ci ? undefined : fromIni({ profile: profile! });
const identity = await new STSClient({ region, credentials }).send(new GetCallerIdentityCommand({}));
if (identity.Account !== account) throw new Error(`AWS account mismatch. Expected ${account}; authenticated account differs. Deployment stopped.`);
console.log(`Verified target AWS account ${account}, region ${region}.`);
const taskEnv: NodeJS.ProcessEnv = { ...process.env, DEPLOY_ACCOUNT: account, DEPLOY_REGION: region, AWS_REGION: region, AWS_DEFAULT_REGION: region };
// CDK must resolve the same profile that passed STS, regardless of shell credentials.
if (!ci) {
  delete taskEnv.AWS_ACCESS_KEY_ID;
  delete taskEnv.AWS_SECRET_ACCESS_KEY;
  delete taskEnv.AWS_SESSION_TOKEN;
  taskEnv.AWS_PROFILE = profile;
}
function run(program: string, parameters: string[]) {
  const result = spawnSync(program, parameters, { env: taskEnv, stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (command === 'deploy') {
  mkdirSync('.local', { recursive: true });
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
  run('npm', ['run', 'build']);
}
const cdkArgs = [command, ...(command === 'bootstrap' ? [`aws://${account}/${region}`] : ['BtcMinute']), '--app', 'npx tsx infra/app.ts', ...(!ci ? ['--profile', profile!] : [])];
if (command === 'deploy') cdkArgs.push('--outputs-file', '.local/deployment-outputs.json', '--require-approval', 'never');
if (ci && command === 'destroy') throw new Error('Destruction is not supported in CI.');
run('npx', ['cdk', ...cdkArgs]);
