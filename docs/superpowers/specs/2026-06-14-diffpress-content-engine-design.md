# DiffPress Content Engine — Design

**Date:** 2026-06-14
**Status:** Approved (brainstorming) — pending implementation plan
**Author:** Phil Gray + Claude

## Summary

Backend infrastructure and business-logic scaffolding for **DiffPress**, a technical
publishing / code-critic workflow. The frontend React UI already exists (`/diffpress`).
This work adds a serverless **Content Engine**: a weekly-triggered AWS Step Functions
workflow that discovers emerging GitHub repos, enriches them, pauses for a
human-in-the-loop handoff, then drafts and records a published article.

The Content Engine is added to the **existing** `constellation-engine` SST Ion app and
follows its established conventions. It does **not** introduce a monorepo, a new API
gateway, or a new auth mechanism.

## Context & key decisions

The original PRD was written against a generic greenfield assumption. The repo is a flat
Astro + SST Ion app, so several PRD specifics were reconciled to the codebase:

| Topic | PRD literal | Decision | Reason |
|-------|-------------|----------|--------|
| Framework | "SST v4 (Ion)" | SST Ion as shipped in `sst@3.x` (already installed: `3.17.12`) | There is no v4; Ion *is* the v3 package. `sst.config.ts` already uses `sst.aws.*` Ion primitives. |
| Code location | `packages/functions/src/` | `src/diffpress/` | Repo is flat (handlers under `src/`, e.g. `src/librarian/*`). A monorepo restructure is out of scope. |
| Ledger storage | dedicated `PublicationLifecycle` table (PK `repoName`) | New `sst.aws.Dynamo` table, `hashKey: repoName`, **no sort key** | Confirmed by user. Clean isolation from existing `UnifiedLake` single-table design. |
| Handoff API | `POST /api/publish-handoff` | New route on existing `IngestApi` (ApiGatewayV2), behind existing Cognito JWT authorizer | Confirmed. Consistent with `/ingest`, `/dashboard`, etc. |
| Pinecone index | index `brain-dump` | Reuse existing Pinecone client (`src/utils.ts`), query the index named `brain-dump` | Confirmed. No new host secret. |
| Phase 2 notification | "SNS/SES or simply log" | Log + persist an `AWAITING_HANDOFF` ledger item | Logging alone isn't retrievable by the UI; the ledger item is. SNS left out (YAGNI). |
| Ledger write step | "DynamoDB Task" | Lambda + AWS SDK write (conditional update) | Instruction asks for "the AWS SDK logic for querying DynamoDB"; far more testable than ASL JSONata. Native `dynamodb:putItem` task noted as alternative. |

## Architecture

A single Step Functions state machine (`ContentEngine`) orchestrates seven Lambda tasks.
A weekly EventBridge cron (via `sst.aws.Cron`) starts it through a small trigger Lambda
(mirroring `src/librarian/trigger.ts`). One paused `waitForTaskToken` state hands control
to the frontend, which resumes the workflow through a new authenticated API route.

```
EventBridge Cron (rate 7 days)
        │
        ▼
  trigger Lambda ── StartExecution ──▶ ContentEngine (Step Functions)
        │
        ├─ 1. DiscoverRepos        (GitHub trending, dedupe vs ledger)
        ├─ 2. EnrichRepos          (Exa/Tavily + HN/Reddit STUB → S3 JSON)
        ├─ 3. SeedIdeas            (Pinecone `brain-dump` query, generate STUB fallback)
        ├─ 4. AwaitHandoff         (lambdaInvoke integration:"token"  ── PAUSE)
        │         notifyHandoff Lambda: log token + S3 loc,
        │         write {repoName, status:AWAITING_HANDOFF, taskToken, payloadKey}
        │                         ▲
        │   POST /api/publish-handoff (Cognito JWT) ── SendTaskSuccess ──┘
        │
        ├─ 5. DraftArticle         (read S3 payload + repoUrl + developerLog → article STUB)
        └─ 6. RecordPublication    (conditional update ledger item → PUBLISHED)
```

## Infrastructure (added to `sst.config.ts`)

All resources are defined inside the existing `run()` block, reusing existing secrets.

- **`ContentPayloadBucket`** — `new sst.aws.Bucket("ContentPayloadBucket")`. Holds Phase 1
  enrichment JSON, keyed `enrichment/<executionId>/<repoName>.json`.
- **`PublicationLifecycle`** — `new sst.aws.Dynamo("PublicationLifecycle", { fields: { repoName: "string" }, primaryIndex: { hashKey: "repoName" } })`.
- **`ContentEngine`** — `new sst.aws.StepFunctions("ContentEngine", { definition })` built from
  the `sst.aws.StepFunctions.lambdaInvoke(...)` chain.
- **`ContentEngineTrigger`** — `sst.aws.Function`, `link: [ContentEngine]`,
  `permissions: [{ actions: ["states:StartExecution"], resources: [ContentEngine.arn] }]`.
- **`ContentEngineCron`** — `new sst.aws.Cron("ContentEngineCron", { schedule: "rate(7 days)", job: <trigger function def> })`.
  (Cron's `job` can inline the trigger handler directly; a standalone trigger function is only
  needed if we also want a manual HTTP trigger. Plan will pick one — default: inline cron job.)
- **API route** on the existing `api` (`IngestApi`):
  ```ts
  api.route("POST /api/publish-handoff", {
    handler: "src/diffpress/publishHandoff.handler",
    link: [auth, PublicationLifecycle],
    permissions: [{ actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: ["*"] }],
    timeout: "30 seconds",
  }, { auth: { jwt: { authorizer: authorizer.id } } });
  ```

### Returned outputs
Add `contentPayloadBucket: ContentPayloadBucket.name` and `publicationTable: PublicationLifecycle.name`
to the `run()` return for visibility.

## State machine definition

Built with the Ion builder API already used by the librarian workflow:

```ts
const discover   = sst.aws.StepFunctions.lambdaInvoke({ name: "DiscoverRepos",   function: fns.discoverRepos,   output: {...} });
const enrich     = sst.aws.StepFunctions.lambdaInvoke({ name: "EnrichRepos",     function: fns.enrichRepos,     payload: {...}, output: {...} });
const seed       = sst.aws.StepFunctions.lambdaInvoke({ name: "SeedIdeas",       function: fns.seedIdeas,       payload: {...}, output: {...} });
const awaitHand  = sst.aws.StepFunctions.lambdaInvoke({ name: "AwaitHandoff",    function: fns.notifyHandoff,   integration: "token",
                     payload: { taskToken: "{% $states.context.Task.Token %}", payload: "{% $states.input %}" }, output: {...} });
const draft      = sst.aws.StepFunctions.lambdaInvoke({ name: "DraftArticle",    function: fns.draftArticle,    payload: {...}, output: {...} });
const record     = sst.aws.StepFunctions.lambdaInvoke({ name: "RecordPublication", function: fns.recordPublication, payload: {...} });

const definition = discover.next(enrich).next(seed).next(awaitHand).next(draft).next(record);
```

- The exact JSONata `payload`/`output` mappings are an implementation detail; the plan will
  specify them. The task-token is read from `$states.context.Task.Token` and forwarded to
  `notifyHandoff`.
- `integration: "token"` causes SST to append `.waitForTaskToken` to the task resource
  (verified in `.sst/platform/src/components/aws/step-functions/task.ts`). The execution
  pauses at `AwaitHandoff` until `SendTaskSuccess`/`SendTaskFailure` is called with that token.

## Handler files (`src/diffpress/`)

Each handler: typed I/O, lazy clients reused from `src/utils.ts` where possible, `try/catch`
that **throws** on hard failure (so Step Functions can Catch/Retry), structured `console.log`.

| File | Purpose | Reads/links |
|------|---------|-------------|
| `types.ts` | Shared types: `RepoCandidate`, `EnrichmentPayload`, `SeedIdea`, `ContentEngineState`, `HandoffRequest`, `PublicationRecord`, ledger status enum. | — |
| `discoverRepos.ts` | Fetch top emerging repos via `getOctokit()` (GitHub search). Filter out repos already `PUBLISHED` in the ledger. Return `RepoCandidate[]` + chosen repo. | `GITHUB_*`, `PublicationLifecycle` |
| `enrichRepos.ts` | **STUB** Exa/Tavily doc fetch + HN/Reddit sentiment. Assemble `EnrichmentPayload`, `PutObject` to S3, return `{ bucket, key }`. | `ContentPayloadBucket` |
| `seedIdeas.ts` | Query Pinecone index `brain-dump` for relevant seed ideas; **STUB** generate fallback when empty. | `PINECONE_API_KEY` (+ `GEMINI_API_KEY` for fallback stub) |
| `notifyHandoff.ts` | Receive `taskToken` + S3 location. Log them. Write `AWAITING_HANDOFF` ledger item carrying `taskToken` + `payloadKey`. Return immediately (state stays paused). | `PublicationLifecycle` |
| `publishHandoff.ts` | **API handler.** Verify JWT user (`event.requestContext.authorizer.jwt.claims.sub`). Parse `{ taskToken, repoUrl, developerLog }`. Call `SendTaskSuccess` with that payload as output. 401/400/202/500. | `auth`, `states:SendTaskSuccess/Failure` |
| `draftArticle.ts` | `GetObject` the S3 enrichment payload; combine with `repoUrl` + `developerLog` into article markdown (**LLM STUB**). Return `{ articleMarkdown, title, ... }`. | `ContentPayloadBucket`, `GEMINI_API_KEY` |
| `recordPublication.ts` | Conditional update of the ledger item → `PUBLISHED` with article metadata + `publishedAt`. Treat `ConditionalCheckFailed` as already-published (no throw). | `PublicationLifecycle` |
| `lib/ledger.ts` | Typed helpers for `PublicationLifecycle` (`getByRepo`, `putPending`, `markPublished`, `listPublishedNames`). Separate from `src/lib/dynamo.ts` (hardwired to `UnifiedLake`). | `PublicationLifecycle` |
| `lib/payloadStore.ts` | S3 `putPayload` / `getPayload` helpers (none exist in repo today). | `ContentPayloadBucket` |

## Ledger lifecycle model

One item per repo, `repoName` as the only key:

```
{ repoName, status: "AWAITING_HANDOFF", taskToken, payloadKey, repoUrl?, discoveredAt }
   ─ markPublished ▶
{ repoName, status: "PUBLISHED", title, articleKey?, publishedAt, ...metadata }
```

- Dedupe in `discoverRepos` filters candidates whose `repoName` already has `status = PUBLISHED`.
- `recordPublication` uses a conditional update so a re-run can't double-publish.

## IAM (least privilege via `link` + targeted `permissions`)

- Resource access is granted by `link: [...]` on each function (SST binds `Resource.X` and
  attaches the matching IAM policy).
- `discoverRepos` → `PublicationLifecycle`, GitHub secrets.
- `enrichRepos`, `draftArticle` → `ContentPayloadBucket` (+ `GEMINI_API_KEY` for draft).
- `seedIdeas` → `PINECONE_API_KEY` (+ `GEMINI_API_KEY`).
- `notifyHandoff`, `recordPublication` → `PublicationLifecycle`.
- `ContentEngineTrigger` / cron job → `states:StartExecution` on `ContentEngine.arn`.
- `publishHandoff` → `states:SendTaskSuccess` + `states:SendTaskFailure`, resource `*`
  (task tokens are opaque and not addressable by ARN), plus `link: [PublicationLifecycle]`.
- The Step Functions execution role is auto-granted `lambda:InvokeFunction` for each task by SST.

## Error handling

- Task Lambdas throw on unrecoverable errors; the plan may add `.retry()`/`.catch()` to the
  state machine where appropriate (default: rely on Step Functions' built-in Lambda retry).
- `publishHandoff`: `401` (no JWT user), `400` (missing `taskToken`/`repoUrl`/`developerLog`),
  `202` (resumed), `500` (SDK error). On a known bad token, surface the SDK error as `400`.
- `recordPublication`: `ConditionalCheckFailedException` → log + return success (idempotent).
- `draftArticle`: missing/invalid S3 object → throw with a clear message.

## Out of scope (YAGNI)

- Real implementations of the LLM drafting agent, Exa/Tavily, and HN/Reddit sentiment — all stubs.
- SNS topic / SES email (logging + ledger item satisfies Phase 2 retrievability).
- A `GET` endpoint to list pending handoffs (not in the PRD; the frontend service stubs can be
  pointed at one later if needed).
- Any monorepo / `packages/` restructure.

## Verification / success criteria

The repo has **no test runner** (nothing in `package.json` scripts/devDeps), and all external
calls are stubbed, so verification is build-level:

1. `npx tsc --noEmit` passes for all new `src/diffpress/**` files (type-correct handlers + shared types).
2. `npx sst diff` (or `sst deploy --stage dev` dry path) builds the resource graph cleanly:
   the `ContentEngine` state machine, bucket, table, cron, and the new API route resolve, and
   all `link`/`permissions` references are valid.

Both must pass before the work is reported complete. (If a lightweight test runner is desired
for the pure-logic helpers — `lib/ledger.ts`, dedupe filter, `publishHandoff` validation — that
can be added in the plan, but it is not required by this spec.)
