# Usage Metering and Quota Service

A multi-tenant backend service designed to track resource consumption, atomically enforce dual-hierarchy monthly quotas and per-request limits, and provide auditable usage reporting for accounts and individual users. Built with TypeScript, Node.js, Express, PostgreSQL, and Drizzle ORM.

## Table of Contents

1. [Project Overview and Purpose](#project-overview-and-purpose)
2. [Core Features and Use Cases](#core-features-and-use-cases)
3. [Technology Stack](#technology-stack)
4. [Architecture and System Responsibilities](#architecture-and-system-responsibilities)
5. [Environment Configuration](#environment-configuration)
6. [Security and Multi-Tenant Isolation](#security-and-multi-tenant-isolation)
7. [Plan Hierarchy and Quota Rules](#plan-hierarchy-and-quota-rules)
8. [Getting Started and Deployment](#getting-started-and-deployment)
9. [Interactive Demo Client](#interactive-demo-client)
10. [API Reference](#api-reference)
11. [Quota Enforcement and Idempotency Semantics](#quota-enforcement-and-idempotency-semantics)
12. [Automated and Performance Testing](#automated-and-performance-testing)
13. [Assumptions, Limitations, and Troubleshooting](#assumptions-limitations-and-troubleshooting)

## Project Overview and Purpose

The Usage Metering and Quota Service addresses the operational challenge of tracking API consumption across a multi-tiered organization. Modern software-as-a-service platforms must prevent unauthorized usage, enforce fair-use limits across accounts, and allow individual users within those accounts to operate under dedicated sub-quotas.

This service acts as an authoritative metering and quota enforcement gateway. It validates incoming consumption requests in real time, applies dual-hierarchy constraints across both account-level and user-level allowances, serializes concurrent requests to prevent race conditions, guarantees idempotency for network retries, and maintains an immutable audit ledger of every accepted and rejected request.

## Core Features and Use Cases

- Dual-Hierarchy Quota Enforcement: Evaluates limits concurrently across two levels. A request must pass the user plan limits as well as the overarching account plan limits.
- Zero-Consumption Rejections: Requests that exceed either per-request thresholds or remaining monthly allowances are rejected with HTTP 429 Quota Exceeded, and exactly zero units are deducted from both counters.
- Concurrency Safety: Employs explicit row-level locking in a deterministic sequence to prevent database deadlocks and race conditions during high-volume parallel requests.
- Strict Idempotency: Supports client-supplied request identifiers. Identical retries return cached responses without duplicate deductions, while conflicting payloads reusing an active identifier return HTTP 409 Conflict.
- Multi-Tenant Isolation: Every resource and operation is cryptographically scoped to the authenticated account. Cross-account queries return HTTP 404 Not Found to prevent tenant enumeration.
- Flexible Plan Management: Predefined plans provide out-of-the-box tiers, while accounts can define custom plans with customized allowances and request limits.
- Historical Reporting and Audit Ledger: Delivers current-month usage summaries, historical calendar-month reports, and paginated ledger history with stable sorting and filtering.
- Single-Page Demo Interface: Built-in browser client served by the application allows developers to test the full lifecycle, including account creation, user provisioning, plan changes, and real-time quota rejections.

## Technology Stack

- Runtime: Node.js 22 LTS
- Language: TypeScript 5.7
- Web Framework: Express.js 4.21
- Database: PostgreSQL 16
- Database Driver: postgres (Postgres.js v3.4)
- Object-Relational Mapping and Migrations: Drizzle ORM v0.38 and drizzle-kit
- Testing Framework: Node.js built-in test runner (node:test and node:assert/strict)
- Containerization: Docker and Docker Compose v2

## Architecture and System Responsibilities

The system is composed of three primary components: the API service, the PostgreSQL database, and the static demo client.

### API Service

The Express.js application serves as the primary gateway and business logic coordinator:
- Request Processing: Parses JSON payloads, validates input formats, and checks boundary conditions before querying the database.
- Authentication Middleware: Validates administrative tokens using timing-safe comparisons and maps incoming tenant API keys to account contexts via SHA-256 hash lookups.
- Service Layer: Encapsulates business logic for account management, plan validation, quota evaluations, reporting aggregations, and idempotency handling.
- Transaction Management: Manages database transactions, ensuring that counter locks, quota evaluations, and ledger insertions either commit completely or roll back cleanly.
- Static Hosting: Serves the compiled demo web client and related public assets directly from the application server.

### Database

The PostgreSQL 16 instance acts as the single source of truth for persistent data:
- Relational Schema: Defines normalized tables for accounts, users, plans, usage counters, ledger records, and migration history.
- Relational Constraints: Enforces foreign key relationships with cascading deletes where appropriate, ensuring referential integrity across tenants and users.
- Unique Constraints: Enforces a compound unique index on account ID and client request ID to guarantee idempotency at the database engine level.
- Row-Level Serialization: Supports SELECT FOR UPDATE locking, serializing concurrent writes to monthly usage counters and eliminating double-counting under parallel load.

### Demo Client

The demo client is a standalone single-page application served from the API root:
- User Interface: Provides controls for creating accounts, creating users, defining custom plans, submitting metered usage requests, and viewing summaries and ledgers.
- Credential Security: Holds API keys exclusively in transient JavaScript memory for the lifetime of the browser session. Keys are never written to localStorage, sessionStorage, or browser cookies.
- Server-Side Proxy: Utilizes a dedicated server-side endpoint for initial demo account creation, allowing users to bootstrap an account without exposing administrative master keys in the browser.

## Environment Configuration

Configuration is loaded from environment variables. During development, variables can be defined in a .env file in the project root. The following configuration variables are supported:

- NODE_ENV: Operating mode. Values are development or production. Default is development.
- PORT: Port number on which the API HTTP server listens. Default is 3000.
- HOST: Network interface address to bind to. Default is 0.0.0.0.
- DB_HOST: Hostname of the PostgreSQL server. Use localhost when running locally on the host machine, or postgres when running within Docker Compose. Default is localhost.
- DB_PORT: Port number exposed by the PostgreSQL service. Default is 5433 for local host access, avoiding conflicts with default local PostgreSQL instances on port 5432. Inside Docker Compose, this maps to container port 5432.
- DB_USER: PostgreSQL database username. Default is metering_user.
- DB_PASSWORD: Password for the PostgreSQL database user. Default is metering_pass.
- DB_NAME: PostgreSQL database name. Default is usage_metering.
- DATABASE_URL: Full connection string. When provided, this overrides individual DB parameters. Default is constructed from the DB variables.
- ADMIN_API_KEY: Secret token required for administrative provisioning endpoints. Default is a development token.

Security note: Never commit real credentials or production secrets to version control. Keep administrative tokens restricted to trusted server-to-server environments.

## Security and Multi-Tenant Isolation

### Administrative Authentication

Administrative endpoints, such as initial account creation, are protected by the X-Admin-Key header or an Authorization Bearer token. The server verifies administrative keys using crypto.timingSafeEqual over fixed-length SHA-256 digests. This prevents side-channel timing attacks that attempt to deduce valid tokens based on string comparison duration.

### Tenant API Key Security

Each account is provisioned with an API key generated using 24 cryptographically secure random bytes, encoded as a URL-safe base64 string with the prefix umq_live_.
- The plaintext API key is returned exactly once upon account creation.
- The database stores only the SHA-256 hash of the API key in the accounts table.
- Incoming requests provide the key via the X-API-Key header or Authorization Bearer header. The key is hashed upon receipt and matched against stored records.
- Plaintext API keys cannot be recovered from the database. If lost, a new key must be assigned.

### Multi-Tenant Isolation

Tenant isolation is enforced in all SQL queries:
- Every tenant endpoint requires authentication and resolves the active account context before proceeding.
- Data queries filter strictly by the resolved account ID.
- Access attempts against users, custom plans, or usage records belonging to another tenant return HTTP 404 Not Found. This prevents unauthorized callers from confirming whether a resource exists under another account.

## Plan Hierarchy and Quota Rules

### Predefined Plans

The service seeds four immutable predefined plans upon database initialization:

- Starter Account Plan: Scope is ACCOUNT. Monthly allowance is 10,000 units. Maximum units per request is 500 units. Predefined and read-only.
- Pro Account Plan: Scope is ACCOUNT. Monthly allowance is 100,000 units. Maximum units per request is 5,000 units. Predefined and read-only.
- Basic User Plan: Scope is USER. Monthly allowance is 1,000 units. Maximum units per request is 100 units. Predefined and read-only.
- Premium User Plan: Scope is USER. Monthly allowance is 10,000 units. Maximum units per request is 1,000 units. Predefined and read-only.

Predefined plans cannot be updated or deleted. Modification attempts return HTTP 403 Forbidden.

### Custom Plans

Accounts may create custom plans to meet specific business requirements:
- Custom plans can be created with either ACCOUNT or USER scope.
- The plan name must be unique within that scope for the owning account.
- The maxUnitsPerRequest parameter must be a positive integer less than or equal to monthlyAllowance.
- Custom plans can be updated by the owning account. Updates must preserve the constraint that maxUnitsPerRequest does not exceed monthlyAllowance.
- Cross-account updates or updates to predefined plans are rejected.

### Plan Assignment and Effective Timing

- Account plans are assigned during account creation and can be updated using the account plan update endpoint.
- User plans are assigned during user creation and can be updated using the user plan update endpoint.
- Plan changes take effect immediately for all subsequent usage evaluations.
- Historical records in the usage ledger retain their immutable historical snapshot, including the units consumed and rejection details recorded at the time of the request.

### Dual-Hierarchy Quota Rules and Evaluation Sequence

Whenever a usage request arrives, the metering engine evaluates four rules in strict hierarchical sequence:

1. Rule 1 (User Maximum Per Request): The requested units must not exceed the user plan's maxUnitsPerRequest. If violated, the request is rejected with reason USER_MAX_PER_REQUEST_EXCEEDED.
2. Rule 2 (Account Maximum Per Request): The requested units must not exceed the account plan's maxUnitsPerRequest. If violated, the request is rejected with reason ACCOUNT_MAX_PER_REQUEST_EXCEEDED.
3. Rule 3 (User Monthly Allowance): The user's current monthly consumed units plus the requested units must not exceed the user plan's monthlyAllowance. If violated, the request is rejected with reason USER_MONTHLY_QUOTA_EXCEEDED.
4. Rule 4 (Account Monthly Allowance): The account's current monthly consumed units plus the requested units must not exceed the account plan's monthlyAllowance. If violated, the request is rejected with reason ACCOUNT_MONTHLY_QUOTA_EXCEEDED.

If any rule is violated:
- An HTTP 429 Quota Exceeded response is returned immediately with the corresponding rejection reason.
- A record is persisted to the usage ledger with unitsConsumed set to 0 and status set to REJECTED.
- Neither the user's monthly usage counter nor the account's monthly usage counter is incremented.

## Getting Started and Deployment

### Prerequisites

- Docker Desktop or Docker Engine with Docker Compose v2.
- Node.js 22 LTS and npm (only required if running outside containers or executing local scripts).

### Running with Docker Compose (Recommended)

1. Navigate to the project directory:

```bash
cd c:\Users\PC\Desktop\usage-metering-quota-service
```

2. Start the services using Docker Compose:

```bash
docker compose up -d --build
```

Docker Compose builds the API image, starts the PostgreSQL database, and starts the API service. The API service depends on PostgreSQL achieving a healthy status via pg_isready. On startup, the API automatically executes database migrations and idempotent predefined-plan seeding before opening the HTTP port.

3. Verify service health:

```bash
curl http://localhost:3000/health
```

Expected response:

```json
{
  "status": "ok",
  "timestamp": "2026-10-17T10:14:59.879Z",
  "database": "connected"
}
```

4. Open the interactive demo interface in a web browser:

```text
http://localhost:3000/
```

### Local Development Setup

If running Node.js directly on the host machine:

1. Install project dependencies:

```bash
npm install
```

2. Start the PostgreSQL container:

```bash
docker compose up -d postgres
```

3. Run database migrations:

```bash
npm run db:migrate
```

4. Seed the predefined plans:

```bash
npm run db:seed
```

5. Start the development server with live reload:

```bash
npm run dev
```

6. Build and run in production mode:

```bash
npm run build
npm start
```

## Interactive Demo Client

The application includes an interactive browser client accessible at http://localhost:3000/. It is served directly by the Express backend and requires no separate frontend build step.

Key capabilities of the demo interface:
- Account Provisioning: Create an account using the server-side demo proxy with predefined Starter or Pro plans, or enter an existing API key.
- User Management: Create users under the active account, list users, and update user plan assignments.
- Plan Management: View predefined plans, create custom account or user plans, and update existing custom plans.
- Usage Metering: Submit usage requests specifying user ID, requested units, and client request IDs. The UI displays real-time responses showing accepted units or specific rejection reasons.
- Usage Summaries: View current UTC-month account usage, allowances, remaining balance, and user-by-user breakdowns.
- Monthly Reporting: View aggregate usage counts and breakdowns for any specified calendar month.
- Audit History: Browse paginated request history with user and status filtering.
- Session Management: The API key is held exclusively in memory. Clicking "Forget key" clears the active session immediately.

## API Reference

### Common Authentication Headers

- Administrative endpoints: X-Admin-Key: <ADMIN_API_KEY> or Authorization: Bearer <ADMIN_API_KEY>
- Tenant endpoints: X-API-Key: <API_KEY> or Authorization: Bearer <API_KEY>
- Idempotency header: Idempotency-Key: <clientRequestId> (optional if provided in request body)

### Health Check

#### GET /health

Returns service health and database connection status. Does not require authentication.

Response (200 OK):

```json
{
  "status": "ok",
  "timestamp": "2026-10-17T10:14:59.879Z",
  "database": "connected"
}
```

### Administrative Endpoints

#### POST /api/v1/accounts

Creates a new account. Requires administrative authentication.

Request headers:
- X-Admin-Key: <ADMIN_API_KEY>

Request body:

```json
{
  "name": "Acme Corporation",
  "planId": "082857e9-4236-485b-ae0a-fefb8a5ee038"
}
```

Response (201 Created):

```json
{
  "id": "e7b1a2c3-4d5e-6f70-8192-a3b4c5d6e7f8",
  "name": "Acme Corporation",
  "planId": "082857e9-4236-485b-ae0a-fefb8a5ee038",
  "apiKey": "umq_live_38f29c01...",
  "createdAt": "2026-10-17T10:00:00.000Z"
}
```

The plaintext apiKey is returned only once at creation.

### Account Endpoints

#### GET /api/v1/accounts/me

Returns the authenticated account profile and current plan details.

Request headers:
- X-API-Key: <API_KEY>

#### PATCH /api/v1/accounts/me/plan

Updates the account's assigned plan. Can be a predefined ACCOUNT plan or a custom ACCOUNT plan owned by the account.

Request headers:
- X-API-Key: <API_KEY>

Request body:

```json
{
  "planId": "d21f5459-8fb7-4d6a-b330-230745a51aec"
}
```

Response (200 OK): Returns the updated account record.

### User Endpoints

#### GET /api/v1/users

Lists all users belonging to the authenticated account.

Request headers:
- X-API-Key: <API_KEY>

#### GET /api/v1/users/:id

Retrieves details for a specific user. Returns 404 Not Found if the user does not exist or belongs to another account.

Request headers:
- X-API-Key: <API_KEY>

#### POST /api/v1/users

Creates a new user under the authenticated account.

Request headers:
- X-API-Key: <API_KEY>

Request body:

```json
{
  "name": "alice_developer",
  "planId": "87ca9bce-591e-4c9b-a661-382d1ee6b35e"
}
```

Response (201 Created): Returns the created user object.

#### PATCH /api/v1/users/:id/plan

Updates a user's assigned USER-scoped plan.

Request headers:
- X-API-Key: <API_KEY>

Request body:

```json
{
  "planId": "87ca9bce-591e-4c9b-a661-382d1ee6b35e"
}
```

Response (200 OK): Returns the updated user object.

### Plan Endpoints

#### GET /api/v1/plans

Lists all plans accessible to the authenticated account. This includes all predefined plans and any custom plans created by the account.

Request headers:
- X-API-Key: <API_KEY>

#### GET /api/v1/plans/:id

Retrieves a single plan by UUID. Returns predefined plans or custom plans owned by the authenticated account. Returns 404 Not Found for non-existent plans or plans owned by other accounts.

Request headers:
- X-API-Key: <API_KEY>

Response (200 OK):

```json
{
  "id": "7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d",
  "name": "Custom Team Plan",
  "scope": "ACCOUNT",
  "monthlyAllowance": 50000,
  "maxUnitsPerRequest": 2000,
  "isCustom": true,
  "accountId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "createdAt": "2026-10-17T09:00:00.000Z",
  "updatedAt": "2026-10-17T09:00:00.000Z"
}
```

#### POST /api/v1/plans

Creates a custom plan owned by the authenticated account.

Request headers:
- X-API-Key: <API_KEY>

Request body:

```json
{
  "name": "Enterprise High-Volume",
  "scope": "ACCOUNT",
  "monthlyAllowance": 500000,
  "maxUnitsPerRequest": 10000
}
```

Response (201 Created): Returns the created custom plan.

#### PUT /api/v1/plans/:id

Updates an existing custom plan owned by the authenticated account. Predefined plans cannot be updated and return 403 Forbidden.

Request headers:
- X-API-Key: <API_KEY>

Request body:

```json
{
  "name": "Enterprise High-Volume (Updated)",
  "monthlyAllowance": 750000,
  "maxUnitsPerRequest": 15000
}
```

Response (200 OK):

```json
{
  "id": "7a8b9c0d-1e2f-3a4b-5c6d-7e8f9a0b1c2d",
  "name": "Enterprise High-Volume (Updated)",
  "scope": "ACCOUNT",
  "monthlyAllowance": 750000,
  "maxUnitsPerRequest": 15000,
  "isCustom": true,
  "accountId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "createdAt": "2026-10-17T09:00:00.000Z",
  "updatedAt": "2026-10-17T10:30:00.000Z"
}
```

### Usage Metering Endpoints

#### POST /api/v1/usage

Atomically records usage against both the account and user counters.

Request headers:
- X-API-Key: <API_KEY>
- Idempotency-Key: <clientRequestId> (optional if provided in request body)

Request body:

```json
{
  "userId": "b4c5d6e7-f8a1-2b3c-4d5e-6f7a8b9c0d1e",
  "units": 50,
  "clientRequestId": "req-98765-abcdef"
}
```

Accepted response (200 OK):

```json
{
  "status": "ACCEPTED",
  "requestId": "req-98765-abcdef",
  "unitsRequested": 50,
  "unitsConsumed": 50,
  "period": "2026-10",
  "message": "Successfully recorded 50 usage units",
  "accountUsage": { "used": 150, "allowance": 10000 },
  "userUsage": { "used": 50, "allowance": 1000 },
  "createdAt": "2026-10-17T10:15:00.000Z"
}
```

Quota exceeded response (429 Quota Exceeded):

```json
{
  "status": "REJECTED",
  "error": "QUOTA_EXCEEDED",
  "reason": "USER_MAX_PER_REQUEST_EXCEEDED",
  "message": "Request of 150 units exceeds user plan maximum of 100 units per request",
  "requestId": "req-98765-abcdef",
  "unitsRequested": 150,
  "unitsConsumed": 0,
  "period": "2026-10",
  "accountUsage": { "used": 150, "allowance": 10000 },
  "userUsage": { "used": 50, "allowance": 1000 },
  "createdAt": "2026-10-17T10:15:30.000Z"
}
```

Conflict response (409 Conflict): Returned when clientRequestId was previously used with a different userId or units payload.

### Summaries, Reports, and History Endpoints

#### GET /api/v1/usage/summary

Returns current UTC-month usage, monthly allowance, remaining units, and per-user breakdown for the authenticated account.

Request headers:
- X-API-Key: <API_KEY>

Response (200 OK):

```json
{
  "period": "2026-10",
  "account": {
    "id": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
    "name": "Acme Corp",
    "plan": {
      "id": "11111111-1111-1111-1111-111111111111",
      "name": "Pro",
      "scope": "ACCOUNT",
      "monthlyAllowance": 100000,
      "maxUnitsPerRequest": 5000,
      "isCustom": false
    },
    "used": 1500,
    "allowance": 100000,
    "remaining": 98500
  },
  "users": [
    {
      "id": "b4c5d6e7-f8a1-2b3c-4d5e-6f7a8b9c0d1e",
      "name": "Alice Developer",
      "plan": {
        "id": "33333333-3333-3333-3333-333333333333",
        "name": "Premium",
        "scope": "USER",
        "monthlyAllowance": 10000,
        "maxUnitsPerRequest": 1000,
        "isCustom": false
      },
      "used": 500,
      "allowance": 10000,
      "remaining": 9500
    }
  ]
}
```

#### GET /api/v1/usage/reports/monthly

Returns historical aggregate usage and per-user breakdown for a specific calendar month.

Request headers:
- X-API-Key: <API_KEY>

Query parameters:
- period: Calendar period in YYYY-MM format. Validated against strict regex.

Response (200 OK):

```json
{
  "period": "2026-10",
  "accountId": "a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
  "summary": {
    "totalRequests": 12,
    "acceptedRequests": 10,
    "rejectedRequests": 2,
    "totalUnitsRequested": 650,
    "totalUnitsConsumed": 500
  },
  "userBreakdown": [
    {
      "userId": "b4c5d6e7-f8a1-2b3c-4d5e-6f7a8b9c0d1e",
      "userName": "Alice Developer",
      "totalRequests": 12,
      "acceptedRequests": 10,
      "rejectedRequests": 2,
      "totalUnitsRequested": 650,
      "totalUnitsConsumed": 500
    }
  ]
}
```

#### GET /api/v1/usage/history

Returns a paginated audit ledger of all usage requests (accepted and rejected) with deterministic sorting (createdAt DESC, id DESC).

Request headers:
- X-API-Key: <API_KEY>

Query parameters:
- page: Page number. Default is 1. Minimum is 1.
- limit: Records per page. Default is 20. Minimum is 1, maximum is 100.
- userId: Optional filter by user UUID. Must belong to the authenticated account.
- status: Optional filter by status. Values are ACCEPTED or REJECTED.

Response (200 OK):

```json
{
  "pagination": {
    "page": 1,
    "limit": 20,
    "totalRecords": 1,
    "totalPages": 1,
    "hasNextPage": false,
    "hasPrevPage": false
  },
  "records": [
    {
      "id": "9f8e7d6c-5b4a-3210-fedc-ba9876543210",
      "clientRequestId": "req-98765-abcdef",
      "userId": "b4c5d6e7-f8a1-2b3c-4d5e-6f7a8b9c0d1e",
      "userName": "Alice Developer",
      "unitsRequested": 50,
      "unitsConsumed": 50,
      "status": "ACCEPTED",
      "rejectionReason": null,
      "period": "2026-10",
      "createdAt": "2026-10-17T10:15:00.000Z"
    }
  ]
}
```

### Demo Proxy Endpoints

#### GET /api/v1/demo/plans

Returns public listing of predefined plans for UI selection without requiring authentication.

#### POST /api/v1/demo/create-account

Creates an account via a server-side proxy using predefined plans, allowing frontend users to initialize testing without exposing the administrative master key.

Request body:

```json
{
  "name": "Demo Organization",
  "planId": "082857e9-4236-485b-ae0a-fefb8a5ee038"
}
```

Response (201 Created): Returns account details including the generated API key.

## Quota Enforcement and Idempotency Semantics

### Request Execution Lifecycle

When a usage request is submitted to POST /api/v1/usage, execution proceeds through the following steps:

1. Input Validation: Verifies that userId is a valid UUID, units is a positive integer, and clientRequestId is a non-empty string.
2. Tenant Verification: Verifies that the user exists and belongs to the authenticated account. If not found, returns HTTP 404 Not Found.
3. Idempotency Pre-Check: Checks the usage_records table for an existing record with the same account ID and clientRequestId.
   - If an existing record has an identical payload (same userId and units), the request is treated as an idempotent retry. The server immediately returns the previously recorded outcome (HTTP 200 if accepted, HTTP 429 if rejected) without incrementing counters or creating duplicate ledger entries.
   - If an existing record has a different payload (different userId or different units), the request is rejected with HTTP 409 Conflict.
4. Transaction Initialization: If no prior record exists, the server opens an explicit PostgreSQL transaction.
5. Counter Upsertion: Inserts missing counter rows into account_monthly_usage and user_monthly_usage for the current UTC period using ON CONFLICT DO NOTHING.
6. Deterministic Row Locking: Locks the usage counter rows in a strict, deterministic sequence using SELECT ... FOR UPDATE:
   - First lock: account_monthly_usage for the account and current period.
   - Second lock: user_monthly_usage for the user and current period.
   - This deterministic locking sequence eliminates circular wait conditions and prevents deadlocks under high concurrency.
7. Quota Rule Evaluation: Evaluates the four quota rules in order:
   - Rule 1: units <= user plan maxUnitsPerRequest.
   - Rule 2: units <= account plan maxUnitsPerRequest.
   - Rule 3: user used + units <= user plan monthlyAllowance.
   - Rule 4: account used + units <= account plan monthlyAllowance.
8. Rejection Execution: If any rule fails:
   - Persists a ledger record with unitsConsumed set to 0, status set to REJECTED, and the specific rejection reason.
   - The monthly counters remain untouched.
   - The transaction commits, and an HTTP 429 response is returned.
9. Acceptance Execution: If all rules pass:
   - Increments account_monthly_usage.units_used by units.
   - Increments user_monthly_usage.units_used by units.
   - Persists a ledger record with unitsConsumed set to units and status set to ACCEPTED.
   - The transaction commits, and an HTTP 200 response is returned.
10. Concurrency Conflict Handling: If two identical requests arrive simultaneously and race past the initial idempotency check, the second transaction hits the unique constraint on (account_id, client_request_id), triggering PostgreSQL error 23505. The application catches this error, rolls back the secondary transaction, and fetches the winning transaction's record outside the aborted transaction, returning the original result without double-counting.

## Automated and Performance Testing

### Automated Test Suite

The automated test suite runs against PostgreSQL using the Node.js built-in test runner. Tests boot an ephemeral server instance and verify all endpoints and edge cases.

To execute the automated test suite:

```bash
npm test
```

Historical recorded test results from the test suite execution (task-644.log):
- Total tests executed: 88 passed, 0 failed, 0 skipped.
- Total test suites: 25 suites passed.
- Execution duration: approximately 8.36 seconds.

Test coverage breakdown:
- tests/health.test.ts: Verifies service availability, database connectivity, and 404 handling for unrecognized routes.
- tests/stage2.test.ts: Verifies administrative authentication, account creation, user creation, plan assignment, predefined plan immutability, and tenant isolation.
- tests/stage3.test.ts: Verifies atomic quota enforcement, all four rejection rules, zero-consumption rejections, idempotent replay, conflict detection, and concurrent race resolution.
- tests/stage4.test.ts: Verifies monthly usage summaries, historical reports by calendar month with regex validation, and paginated ledger history with stable sorting and filtering.
- tests/stage5.test.ts: Verifies static demo client delivery at the root URL, demo account creation proxy, and client secret hygiene.
- tests/stage6.test.ts: Verifies full end-to-end integration across custom plan lifecycle, tenant boundaries, and multi-step user workflows.

### Performance and Load Benchmark

The performance suite executes high-concurrency throughput tests and idempotency stampede tests against an isolated, uniquely named test account.

To execute the performance suite:

```bash
npm run test:perf
```

Methodology:
- Setup: Creates an isolated test account with the Pro plan and an isolated test user with the Premium plan.
- Benchmark 1 (Concurrent Metering): Fires 150 metered usage requests across 15 parallel workers, each requesting 25 units. Measures latency distribution and verifies that total consumed units match expected deductions exactly.
- Benchmark 2 (Idempotency Stampede): Fires 30 simultaneous requests with the exact same clientRequestId in a single burst. Verifies that race resolution, row serialization, and uniqueness constraints prevent double-counting.
- Cleanup: Performs targeted, transactional deletion of the temporary benchmark account and its cascading records.

Historical recorded benchmark results (task-634.log):
- Benchmark 1 completed 150 requests in 4,778 milliseconds.
- Measured throughput: 31.39 requests per second.
- Success count: 150 requests (HTTP 200).
- Error count: 0 server errors (0.00% error rate).
- Latency minimum: 184.66 ms.
- Latency average: 466.53 ms.
- Latency p50: 378.22 ms.
- Latency p95: 1012.24 ms.
- Latency p99: 1130.38 ms.
- Latency maximum: 1178.27 ms.
- Quota consistency check: exactly 3,750 units consumed against 3,750 expected units.
- Benchmark 2 idempotency stampede completed 30 simultaneous requests in 584 milliseconds.
- Stampede results: 30 of 30 responses returned HTTP 200, with exactly 50 units deducted (zero double-counting).
- Targeted cleanup completed successfully, removing exactly 1 benchmark account.

## Assumptions, Limitations, and Troubleshooting

### Assumptions

- UTC Time Boundaries: All monthly accounting periods operate strictly on UTC calendar months (YYYY-MM). Usage resets automatically when the UTC calendar month turns.
- Positive Integer Units: All quota limits, request units, and allowances operate exclusively on positive integers (units >= 1). Fractional units are not supported.
- Predefined Plan Immutability: Predefined plans (Starter, Pro, Basic, Premium) serve as system-level constants and cannot be modified by any account.

### Limitations

- API Key Recovery: Plaintext API keys are never stored in the database. If a tenant loses their API key, a new key must be assigned by an administrator.
- Database Connection Pool: The default database connection pool is configured to 10 connections. In high-concurrency production deployments, this value should be tuned in src/db/index.ts to match the target PostgreSQL instance capacity.
- Single-Database Configuration: In the default local configuration, automated tests run against the configured application database. Test suites create isolated records with unique identifiers, but running tests repeatedly adds records to the database.

### Troubleshooting

- Port 5432 Conflicts: If host port 5432 is occupied by an existing local PostgreSQL service, the Docker Compose configuration maps the container to host port 5433. Ensure DB_PORT is set to 5433 when connecting from the host machine.
- Static Assets 404 in Production: Ensure npm run build has been executed prior to starting the production server. The build script copies static assets from src/public and migrations from src/db/migrations into the dist/ directory.
- Database Connection Refused: Verify that the PostgreSQL container is running and healthy by running docker compose ps.
