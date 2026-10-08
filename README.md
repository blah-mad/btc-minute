# BTC Minute

[Open the live application](https://d2fd5jox0oh7vv.cloudfront.net)

Predict whether Bitcoin's USD price will go up or down after one minute. A correct prediction earns one point; an incorrect prediction loses one. Your score can go below zero.

React and TypeScript frontend with Volt UI, Better Auth sessions, and an AWS serverless backend. Play as a guest or create an account to keep the same score across devices.

## Run locally

Requires Node.js 22+ and a Java 17+ JDK for DynamoDB Local (including its source compiler). No AWS account or credentials are needed for development.

```sh
npm ci
npm run dev
```

Open `http://127.0.0.1:5173`. The development server starts a checksum-verified DynamoDB Local distribution bound to `127.0.0.1:8010`, creates local tables, and runs a background settlement loop. It fetches real Coinbase prices. Local data and the generated development session secret are stored under the ignored `.local/` directory.

The local loop substitutes for SQS delivery; the game rules, DynamoDB transactions, API, and authentication are the same code used in AWS. A running backend is necessary for settlement. Restarting the development server resumes overdue rounds from the database.

## Rules and fairness

- New players start at zero. Only one unresolved guess is allowed per player.
- The backend fetches a fresh BTC-USD quote when accepting a guess and fixes a deadline 60 seconds after server acceptance.
- A worker starts checking at or after the deadline. The round settles against the first eligible quote successfully recorded by the backend.
- A settlement quote must have a market timestamp at or after the deadline and a different price from the entry quote. Equal prices keep the round open.
- A quote older than 10 seconds, invalid quote, provider timeout, or provider error cannot decide a round. The worker retries without changing the score.
- Prices are compared as exact decimal values. Entry and settlement trade IDs, prices, and market timestamps are retained with the round.
- Queue latency and data outages can delay settlement. The game does not claim to capture the first exchange trade at exactly second 60. Closing the browser does not choose or delay the settlement price.
- The server never accepts client-provided scores, prices, player IDs, or timestamps. The displayed countdown is informational.

Price source: [Coinbase Exchange BTC-USD ticker](https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker). This is a points-only game with no money or prizes.

## Architecture

```text
Browser -> CloudFront -> private S3 frontend
              |
              +-> API Gateway -> API Lambda -> DynamoDB game / auth tables
                                                   |
                                         DynamoDB Stream (new guess)
                                                   |
                                          Scheduling Lambda
                                                   |
                                            Delayed SQS job
                                                   |
                                          Settlement Lambda
                                                   |
                                       Coinbase quote + atomic result
```

All infrastructure is defined in `infra/stack.ts`. Application resources run in `eu-central-1`; CloudFront is global. The API and frontend use one origin. CloudFront forwards cookies to the API with caching disabled. A generated origin secret prevents direct API Gateway access; a CloudFront function overwrites the client address used for authentication rate limits.

The game table contains player profiles, round records, idempotency receipts, and identity mappings. Conditional transactions enforce one active guess and change the score exactly once even if jobs are delivered repeatedly. Saving a guess produces its scheduling event through DynamoDB Streams, avoiding an independent database-write/message-send gap.

Scheduling and settlement have failure queues and CloudWatch alarms. Provider outages and unchanged prices produce new delayed checks. Unexpected processing failures are retried by AWS and eventually sent to the failure queue. Alarms are visible in CloudWatch; add a notification action for unattended operations.

## Authentication

Better Auth provides anonymous and email/password sessions, with a separate DynamoDB auth table. The pinned community adapter is covered by integration tests against DynamoDB Local. Indexed candidates are rechecked with strongly consistent reads to reject deleted/revoked records. New index entries can still be briefly delayed; token lookups have bounded retries and the UI does not silently replace a known identity.

- Guest sessions last 30 days; returning with the same browser restores the score.
- Creating an account carries the guest player and completed score forward.
- Signing into an existing account restores that account's score; scores are never added together.
- Account changes are blocked during a pending round. Registered players can sign out after it finishes.
- Cookies are HttpOnly, SameSite=Lax, and Secure over HTTPS. Authentication endpoints use database-backed rate limiting and origin/CSRF checks.
- Email verification and password recovery are not included in this demo. Email ownership is not verified. Use a demo-only password. Clearing a guest cookie or letting it expire loses access to that guest score.

## Test and build

```sh
npm run typecheck
npm test                 # unit/API/architecture tests; database tests skipped
npm run test:integration # starts DynamoDB Local; includes real auth and transaction tests
npm run test:e2e         # Chromium: actual 60-second round, return, signup, mobile, outage
npm run build
npm run synth           # offline CloudFormation generation with a placeholder account
```

Install the browser once with `npx playwright install chromium` (CI adds `--with-deps`). Browser tests start an isolated local app on port 5174 with deterministic, explicitly configured price fixtures. The normal development server uses live prices. Fixtures are absent from Lambda entry points.

Tests cover price/time boundaries, ties, outages, negative scores, simultaneous submissions, duplicate workers, guest linking, revoked sessions, forged ownership, and deployment configuration. The OpenAPI contract is in `openapi.yaml`; frontend and backend share its generated types. Regenerate them with `npm run generate:api`.

Dependency audit: the pinned CDK library currently bundles a vulnerable `brace-expansion` build dependency. npm cannot override that bundled copy. CDK is used for infrastructure generation and is excluded from the deployed Lambda bundles. Update CDK and rerun `npm audit` when its upstream bundle is fixed; the current audit is not clean.

## Deploy to a selected AWS account

Use a dedicated named AWS CLI profile. Deployment requires an explicit expected account ID and refuses the `default` profile. It checks STS before running CDK and stops if the authenticated account differs. No account is embedded in this repository.

```sh
aws login --profile <new-profile> --region eu-central-1
npm run bootstrap -- --profile <new-profile> --account <12-digit-account>
npm run deploy -- --profile <new-profile> --account <12-digit-account>
```

Browser-based `aws login` requires AWS CLI 2.32.0 or later and creates temporary credentials from a selected console session. If your account uses IAM Identity Center, use `aws sso login --profile <new-profile>` instead. The deployment identity needs permission to bootstrap CDK and provision the services in the stack. Credentials stay in your AWS profile, never in this repository.

CDK generates the session secret and the API origin secret in Secrets Manager. It stores the public application origin in Systems Manager Parameter Store. Deployment outputs include `AppUrl`, table names, and queue URLs, also saved to ignored `.local/deployment-outputs.json`. Open `AppUrl`, complete a round, close/reopen the browser, and verify the score before sharing the deployed link.

The infrastructure uses pay-per-request DynamoDB, on-demand Lambda, and standard SQS. AWS allowances or credits may cover demo use, but the stack is not a guarantee of zero cost. Secrets Manager, S3, API Gateway, logs, and other usage can be billed. There is no VPC, NAT gateway, Kubernetes cluster, or continuously running server in production.

### GitHub deployment

The verification workflow runs automatically. The deployment workflow is manual and only accepts `main`. Configure a GitHub `production` environment with `AWS_ACCOUNT_ID` and `AWS_DEPLOY_ROLE_ARN` variables. The role's OIDC trust must restrict both the repository and the `production` environment; grant it only the CDK deployment permissions required for this account. Bootstrap the account first. No long-lived AWS keys are stored in GitHub.

### Recovery and cleanup

Inspect CloudWatch logs and the two failure-queue alarms if a round remains pending after the price service recovers. Redrive settlement messages from the resolution failure queue to the resolution queue after fixing the cause. A failed scheduling event can be recovered by finding its pending GUESS record and sending `{ "playerId": "...", "guessId": "..." }` to the resolution queue. The worker rechecks the original deadline and ignores already settled rounds. Retry tools must use the same explicitly selected account.

```sh
npm run destroy -- --profile <new-profile> --account <12-digit-account>
```

Player and authentication tables are retained when the stack is destroyed. Review and remove retained tables separately when their data is no longer needed. CDK bootstrap resources are also separate from this application stack.

## Scope and growth

The frontend polls while visible; a shared market-data ingestion stream would reduce external API calls at higher traffic and allow settlement against a retained trade timeline. Provider limits and AWS quotas should be measured before increasing concurrency. This version prioritizes a small, auditable game over charts, leaderboards, multiple currencies, or cross-region deployment.
