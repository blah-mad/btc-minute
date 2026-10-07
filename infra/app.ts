import { App } from 'aws-cdk-lib';
import { BtcMinuteStack } from './stack.js';

const app = new App({ outdir: 'cdk.out' });
new BtcMinuteStack(app, 'BtcMinute', {
  env: { account: process.env.DEPLOY_ACCOUNT ?? '111111111111', region: process.env.DEPLOY_REGION ?? 'eu-central-1' },
  description: 'BTC Minute: browser game, durable sessions, and asynchronous settlement.',
});
app.synth();
