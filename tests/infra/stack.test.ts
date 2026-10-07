import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { buildTableDefinition } from '@datar-platform/better-auth-dynamodb';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import type { NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';

// Test the deployment graph and security configuration offline. Real bundle
// generation remains a separate npm run synth check, owned by the deploy flow.
vi.mock('aws-cdk-lib/aws-lambda-nodejs', async () => {
  const lambda = await import('aws-cdk-lib/aws-lambda');
  return { NodejsFunction: class extends lambda.Function {
    constructor(scope: Construct, id: string, props: NodejsFunctionProps) {
      super(scope, id, { ...props, runtime: props.runtime ?? lambda.Runtime.NODEJS_22_X, code: lambda.Code.fromInline('exports.handler = async () => ({});'), handler: 'index.handler' });
    }
  } };
});
import { BtcMinuteStack } from '../../infra/stack.js';

describe('AWS deployment contract', () => {
  const output = mkdtempSync(join(tmpdir(), 'btc-minute-infra-test-'));
  let template: Template;
  beforeAll(() => {
    const frontend = vi.spyOn(s3deploy.Source, 'asset').mockReturnValueOnce(s3deploy.Source.data('index.html', '<html lang="en"></html>'));
    const app = new App({ outdir: output });
    const stack = new BtcMinuteStack(app, 'BtcTest', { env: { account: '111111111111', region: 'eu-central-1' } });
    template = Template.fromStack(stack);
    app.synth(); // Also detects circular resource dependencies without AWS calls.
    frontend.mockRestore();
  });
  afterAll(() => { vi.restoreAllMocks(); rmSync(output, { recursive: true, force: true }); });

  it('matches the auth adapter table keys and all lookup indexes', () => {
    const expected = buildTableDefinition('ignored', 2);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: expected.KeySchema,
      GlobalSecondaryIndexes: expected.GlobalSecondaryIndexes,
      TimeToLiveSpecification: { AttributeName: '__ba_ttl', Enabled: true },
    });
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
    for (const table of Object.values(template.findResources('AWS::DynamoDB::Table'))) expect(table.DeletionPolicy).toBe('Retain');
  });

  it('uses partial failure handling for both stream scheduling and SQS resolution', () => {
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      StartingPosition: 'TRIM_HORIZON', FunctionResponseTypes: ['ReportBatchItemFailures'],
      MaximumRecordAgeInSeconds: 23 * 60 * 60,
      DestinationConfig: { OnFailure: { Destination: Match.anyValue() } },
      FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ eventName: ['INSERT'], dynamodb: { NewImage: { entity: { S: ['GUESS'] }, status: { S: ['pending'] } } } }) }] },
    });
    template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
      BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'], ScalingConfig: { MaximumConcurrency: 5 },
    });
  });

  it('retains failed jobs and gives each resolver invocation sufficient visibility time', () => {
    template.hasResourceProperties('AWS::SQS::Queue', {
      VisibilityTimeout: 180, MessageRetentionPeriod: 14 * 24 * 60 * 60,
      RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: 6 },
    });
    const workers = Object.values(template.findResources('AWS::Lambda::Function')).filter((resource) => resource.Properties.Environment?.Variables?.RESOLUTION_QUEUE_URL);
    expect(workers).toHaveLength(2);
    for (const worker of workers) expect(worker.Properties.Timeout * 6).toBeLessThanOrEqual(180);
  });

  it('keeps the S3 frontend private and disables API response caching', () => {
    template.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true } });
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: { CacheBehaviors: [Match.objectLike({
        PathPattern: '/api/*',
        CachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad',
        ViewerProtocolPolicy: 'https-only',
        FunctionAssociations: [Match.objectLike({ EventType: 'viewer-request' })],
      })] },
    });
    template.hasResourceProperties('AWS::CloudFront::Function', { FunctionCode: Match.stringLikeRegexp("request.headers\\['x-btc-client-ip'\\].*event.viewer.ip") });
  });

  it('authenticates the API origin and resolves the app URL after the distribution exists', () => {
    const distributions = Object.values(template.findResources('AWS::CloudFront::Distribution'));
    const apiOrigin = distributions[0].Properties.DistributionConfig.Origins.find((origin: Record<string, unknown>) => origin.CustomOriginConfig);
    expect(apiOrigin.OriginCustomHeaders).toEqual([{ HeaderName: 'x-origin-verify', HeaderValue: expect.any(Object) }]);
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/btc-minute/app-origin', Value: Match.anyValue() });
    template.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ APP_ORIGIN_PARAMETER: '/btc-minute/app-origin' }) } });
  });
});
