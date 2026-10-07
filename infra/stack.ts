import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as events from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as apigateway from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { resolve } from 'node:path';

export class BtcMinuteStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);
    // Retain player data even if the application stack is removed.
    const game = new dynamodb.Table(this, 'Game', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const auth = new dynamodb.Table(this, 'Auth', {
      partitionKey: { name: '__ba_pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: '__ba_sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: '__ba_ttl', removalPolicy: RemovalPolicy.RETAIN,
    });
    for (const [indexName, prefix] of [['byType', '__ba_t'], ['lookup1', '__ba_g1'], ['lookup2', '__ba_g2']]) {
      auth.addGlobalSecondaryIndex({ indexName, partitionKey: { name: `${prefix}pk`, type: dynamodb.AttributeType.STRING }, sortKey: { name: `${prefix}sk`, type: dynamodb.AttributeType.STRING }, projectionType: dynamodb.ProjectionType.ALL });
    }
    const failures = new sqs.Queue(this, 'ResolutionFailures', { retentionPeriod: Duration.days(14), encryption: sqs.QueueEncryption.SQS_MANAGED });
    const queue = new sqs.Queue(this, 'Resolution', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: Duration.seconds(180), retentionPeriod: Duration.days(14),
      deadLetterQueue: { queue: failures, maxReceiveCount: 6 },
    });
    const scheduleFailures = new sqs.Queue(this, 'SchedulingFailures', { retentionPeriod: Duration.days(14), encryption: sqs.QueueEncryption.SQS_MANAGED });
    const authSecret = new secretsmanager.Secret(this, 'AuthSecret', { generateSecretString: { passwordLength: 64, excludePunctuation: true } });
    const originSecret = new secretsmanager.Secret(this, 'OriginSecret', { generateSecretString: { passwordLength: 48, excludePunctuation: true } });
    const originParameterName = '/btc-minute/app-origin';
    const functionDefaults = {
      runtime: lambda.Runtime.NODEJS_22_X, architecture: lambda.Architecture.ARM_64,
      memorySize: 256, timeout: Duration.seconds(20),
      bundling: { minify: true, sourceMap: true, target: 'node22', externalModules: [] as string[] },
    };
    const apiFunction = new NodejsFunction(this, 'ApiFunction', {
      ...functionDefaults, entry: resolve('src/server/lambda.ts'), handler: 'handler',
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
      environment: { GAME_TABLE: game.tableName, AUTH_TABLE: auth.tableName, AUTH_SECRET_ARN: authSecret.secretArn, ORIGIN_SECRET_ARN: originSecret.secretArn, APP_ORIGIN_PARAMETER: originParameterName },
    });
    game.grantReadWriteData(apiFunction);
    auth.grantReadWriteData(apiFunction);
    authSecret.grantRead(apiFunction);
    originSecret.grantRead(apiFunction);
    apiFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter${originParameterName}`] }));
    const scheduler = new NodejsFunction(this, 'Scheduler', {
      ...functionDefaults, entry: resolve('src/server/jobs.ts'), handler: 'schedule',
      logGroup: new logs.LogGroup(this, 'SchedulerLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
      environment: { RESOLUTION_QUEUE_URL: queue.queueUrl },
    });
    queue.grantSendMessages(scheduler);
    scheduler.addEventSource(new events.DynamoEventSource(game, {
      startingPosition: lambda.StartingPosition.TRIM_HORIZON,
      batchSize: 10, retryAttempts: 10, maxRecordAge: Duration.hours(23),
      reportBatchItemFailures: true, bisectBatchOnError: true,
      onFailure: new events.SqsDlq(scheduleFailures),
      filters: [lambda.FilterCriteria.filter({ eventName: ['INSERT'], dynamodb: { NewImage: { entity: { S: ['GUESS'] }, status: { S: ['pending'] } } } })],
    }));
    const resolver = new NodejsFunction(this, 'Resolver', {
      ...functionDefaults, entry: resolve('src/server/jobs.ts'), handler: 'resolve',
      logGroup: new logs.LogGroup(this, 'ResolverLogs', { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.DESTROY }),
      environment: { GAME_TABLE: game.tableName, RESOLUTION_QUEUE_URL: queue.queueUrl },
    });
    game.grantReadWriteData(resolver);
    queue.grantSendMessages(resolver);
    resolver.addEventSource(new events.SqsEventSource(queue, { batchSize: 1, reportBatchItemFailures: true, maxConcurrency: 5 }));
    const api = new apigateway.HttpApi(this, 'Api', { defaultIntegration: new HttpLambdaIntegration('App', apiFunction) });
    const stage = api.defaultStage!.node.defaultChild as apigateway.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 50, throttlingRateLimit: 25 };
    const bucket = new s3.Bucket(this, 'Web', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true, removalPolicy: RemovalPolicy.DESTROY, autoDeleteObjects: true,
    });
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        contentTypeOptions: { override: true }, frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentSecurityPolicy: { contentSecurityPolicy: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'", override: true },
      },
    });
    const clientAddress = new cloudfront.Function(this, 'ClientAddress', { code: cloudfront.FunctionCode.fromInline("function handler(event) { var request = event.request; request.headers['x-btc-client-ip'] = {value: event.viewer.ip}; return request; }") });
    const distribution = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html', priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket), viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS, responseHeadersPolicy: securityHeaders },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(`${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`, { customHeaders: { 'x-origin-verify': originSecret.secretValue.unsafeUnwrap() } }),
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          responseHeadersPolicy: securityHeaders,
          functionAssociations: [{ function: clientAddress, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
        },
      },
    });
    new ssm.StringParameter(this, 'AppOrigin', { parameterName: originParameterName, stringValue: `https://${distribution.distributionDomainName}` });
    new s3deploy.BucketDeployment(this, 'WebDeployment', { sources: [s3deploy.Source.asset(resolve('dist'))], destinationBucket: bucket, distribution, distributionPaths: ['/*'], cacheControl: [s3deploy.CacheControl.noCache()] });
    for (const [name, dlq] of [['Resolution', failures], ['Scheduling', scheduleFailures]] as const) {
      new cloudwatch.Alarm(this, `${name}FailureAlarm`, { metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1, treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING, alarmDescription: 'Inspect failed jobs and follow README recovery instructions.' });
    }
    new CfnOutput(this, 'AppUrl', { value: `https://${distribution.distributionDomainName}` });
    new CfnOutput(this, 'GameTable', { value: game.tableName });
    new CfnOutput(this, 'AuthTable', { value: auth.tableName });
    new CfnOutput(this, 'ResolutionQueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'ResolutionFailureQueueUrl', { value: failures.queueUrl });
    new CfnOutput(this, 'SchedulingFailureQueueUrl', { value: scheduleFailures.queueUrl });
  }
}
