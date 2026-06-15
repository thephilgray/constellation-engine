# DiffPress Content Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the serverless "Content Engine" — a weekly Step Functions workflow that discovers GitHub repos, enriches them, pauses for a human handoff, then drafts and records an article — into the existing `constellation-engine` SST Ion app.

**Architecture:** Seven thin Lambda handlers under `src/diffpress/` orchestrated by an `sst.aws.StepFunctions` state machine. Phase 2 is a `lambdaInvoke({ integration: "token" })` pause; the frontend resumes it via a new Cognito-JWT route `POST /api/publish-handoff` on the existing `IngestApi`. A dedicated `PublicationLifecycle` DynamoDB table tracks each repo through `AWAITING_HANDOFF → PUBLISHED`. External LLM/search calls are stubs.

**Tech Stack:** SST Ion (`sst@3.17.12`, `sst.aws.*` primitives), AWS Lambda (Node/TS), Step Functions (JSONata), DynamoDB (`@aws-sdk/lib-dynamodb`), S3 (`@aws-sdk/client-s3`), Octokit, Pinecone (via existing `src/utils.ts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-14-diffpress-content-engine-design.md`

---

## File Structure

**New files (`src/diffpress/`):**
- `types.ts` — shared TypeScript types for state, candidates, payloads, handoff, records.
- `lib/ledger.ts` — `PublicationLifecycle` table access + pure param builders + `isAlreadyPublishedError`.
- `lib/payloadStore.ts` — S3 put/get helpers for enrichment payloads.
- `discoverRepos.ts` — handler + pure `filterUnpublished`.
- `enrichRepos.ts` — handler (Exa/Tavily + sentiment stub → S3).
- `seedIdeas.ts` — handler (Pinecone `brain-dump` query + generate stub).
- `notifyHandoff.ts` — handler (log token + write `AWAITING_HANDOFF` ledger item).
- `publishHandoff.ts` — API handler + pure `parseHandoffEvent`.
- `draftArticle.ts` — handler (read S3 + repoUrl + developerLog → article stub).
- `recordPublication.ts` — handler (conditional update → `PUBLISHED`).
- `trigger.ts` — shared cron + manual-HTTP StartExecution handler.
- `lib/ledger.test.ts`, `discoverRepos.test.ts`, `publishHandoff.test.ts` — Vitest unit tests for pure seams.

**Modified files:**
- `package.json` — add `@aws-sdk/client-s3`, `vitest`; add `"test"` script.
- `sst.config.ts` — add bucket, table, functions, state machine, cron, trigger, API route, outputs.
- `vitest.config.ts` — new, minimal node config.

**Key conventions (match existing repo):**
- Lazy clients; read `Resource.*` **inside** functions (never at module top) so test files can import handlers without an SST binding.
- Handlers `try/catch` and **throw** on hard failure so Step Functions can retry.
- Reuse `getEmbedding` and `queryPinecone` from `src/utils.ts` (both exported). `getOctokit` is NOT exported, so `discoverRepos` makes its own Octokit client.

---

## Task 1: Project setup — dependencies and test runner

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Add runtime + dev dependencies**

Run:
```bash
npm install @aws-sdk/client-s3
npm install -D vitest
```
Expected: both install without peer-dependency errors; `package.json` gains `@aws-sdk/client-s3` in `dependencies` and `vitest` in `devDependencies`.

- [ ] **Step 2: Add the test script**

In `package.json`, add to `"scripts"` (after `"preview"`):
```json
    "test": "vitest run",
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Verify the runner boots (no tests yet)**

Run: `npx vitest run`
Expected: exits cleanly with "No test files found" (exit code 0 or a clear no-files message). This confirms vitest is installed and configured.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add @aws-sdk/client-s3 and vitest test runner"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/diffpress/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// src/diffpress/types.ts

/** A candidate repository discovered from GitHub. */
export interface RepoCandidate {
  repoName: string; // "owner/name" — the ledger partition key
  repoUrl: string;
  description: string;
  stars: number;
  language: string | null;
}

/** Enrichment payload assembled in Phase 1 and written to S3. */
export interface EnrichmentPayload {
  repoName: string;
  repoUrl: string;
  documentation: string; // Exa/Tavily stub output
  sentiment: {
    source: "hackernews" | "reddit" | "stub";
    summary: string;
    score: number; // -1..1
  }[];
  generatedAt: string; // ISO timestamp
}

/** A seed idea retrieved from (or generated for) the brain-dump index. */
export interface SeedIdea {
  id: string;
  text: string;
  score: number; // similarity score; 1 for generated stubs
}

/** Pointer to where an enrichment payload was stored in S3. */
export interface PayloadLocation {
  bucket: string;
  key: string;
}

/** The handoff data the frontend sends back to resume the workflow. */
export interface HandoffData {
  repoUrl: string;
  developerLog: string; // markdown
}

/** The state object threaded through the state machine. */
export interface ContentEngineState {
  repo: RepoCandidate;
  candidates?: RepoCandidate[];
  enrichment?: PayloadLocation;
  seedIdeas?: SeedIdea[];
  handoff?: HandoffData;
  article?: DraftedArticle;
}

/** Output of the drafting agent. */
export interface DraftedArticle {
  title: string;
  articleMarkdown: string;
  draftedAt: string;
}

export type PublicationStatus = "AWAITING_HANDOFF" | "PUBLISHED";

/** An item in the PublicationLifecycle table (PK: repoName). */
export interface PublicationRecord {
  repoName: string;
  status: PublicationStatus;
  repoUrl?: string;
  taskToken?: string;
  payloadKey?: string;
  title?: string;
  discoveredAt?: string;
  publishedAt?: string;
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: PASS (no errors introduced by the new file).

- [ ] **Step 3: Commit**

```bash
git add src/diffpress/types.ts
git commit -m "feat: add DiffPress content engine shared types"
```

---

## Task 3: Ledger helper (`lib/ledger.ts`) — TDD

**Files:**
- Create: `src/diffpress/lib/ledger.ts`
- Test: `src/diffpress/lib/ledger.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/diffpress/lib/ledger.test.ts
import { describe, it, expect } from "vitest";
import {
  buildPendingPutParams,
  buildMarkPublishedParams,
  isAlreadyPublishedError,
} from "./ledger";

describe("buildPendingPutParams", () => {
  it("builds a PutCommand input for an AWAITING_HANDOFF item", () => {
    const params = buildPendingPutParams("MyTable", {
      repoName: "vercel/next.js",
      status: "AWAITING_HANDOFF",
      repoUrl: "https://github.com/vercel/next.js",
      taskToken: "tok-123",
      payloadKey: "enrichment/exec-1/vercel-next.js.json",
      discoveredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(params.TableName).toBe("MyTable");
    expect(params.Item.repoName).toBe("vercel/next.js");
    expect(params.Item.status).toBe("AWAITING_HANDOFF");
    expect(params.Item.taskToken).toBe("tok-123");
  });
});

describe("buildMarkPublishedParams", () => {
  it("builds a conditional UpdateCommand input keyed by repoName", () => {
    const params = buildMarkPublishedParams("MyTable", "vercel/next.js", {
      title: "Inside Next.js",
      publishedAt: "2026-06-14T01:00:00.000Z",
    });
    expect(params.TableName).toBe("MyTable");
    expect(params.Key).toEqual({ repoName: "vercel/next.js" });
    // Only re-publish if not already PUBLISHED.
    expect(params.ConditionExpression).toContain("status");
    expect(params.ExpressionAttributeValues![":published"]).toBe("PUBLISHED");
    expect(params.ExpressionAttributeValues![":title"]).toBe("Inside Next.js");
  });
});

describe("isAlreadyPublishedError", () => {
  it("returns true for a ConditionalCheckFailedException", () => {
    expect(isAlreadyPublishedError({ name: "ConditionalCheckFailedException" })).toBe(true);
  });
  it("returns false for other errors", () => {
    expect(isAlreadyPublishedError({ name: "ResourceNotFoundException" })).toBe(false);
    expect(isAlreadyPublishedError(new Error("boom"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: FAIL — cannot resolve `./ledger` (module not found).

- [ ] **Step 3: Write the implementation**

```ts
// src/diffpress/lib/ledger.ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  type PutCommandInput,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { PublicationRecord } from "../types";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Read the table name lazily so tests can import this module without an SST binding.
function tableName(): string {
  return Resource.PublicationLifecycle.name;
}

/** Pure: build the PutCommand input for a pending (AWAITING_HANDOFF) item. */
export function buildPendingPutParams(
  table: string,
  record: PublicationRecord
): PutCommandInput {
  return {
    TableName: table,
    Item: { ...record },
  };
}

/** Pure: build a conditional UpdateCommand input that flips an item to PUBLISHED. */
export function buildMarkPublishedParams(
  table: string,
  repoName: string,
  meta: { title: string; publishedAt: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression:
      "SET #status = :published, title = :title, publishedAt = :publishedAt",
    // Idempotent: do not re-publish an item already in PUBLISHED state.
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":published": "PUBLISHED",
      ":title": meta.title,
      ":publishedAt": meta.publishedAt,
    },
  };
}

/** Pure: is this error a DynamoDB conditional-check failure (already published)? */
export function isAlreadyPublishedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/** Fetch a single publication record by repoName, or null. */
export async function getByRepo(repoName: string): Promise<PublicationRecord | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: { repoName } })
  );
  return (Item as PublicationRecord) ?? null;
}

/** Write the AWAITING_HANDOFF item carrying the task token + payload location. */
export async function putPending(record: PublicationRecord): Promise<void> {
  await docClient.send(new PutCommand(buildPendingPutParams(tableName(), record)));
}

/** Flip the item to PUBLISHED. Swallows the conditional-check failure (idempotent). */
export async function markPublished(
  repoName: string,
  meta: { title: string; publishedAt: string }
): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand(buildMarkPublishedParams(tableName(), repoName, meta))
    );
  } catch (err) {
    if (isAlreadyPublishedError(err)) {
      console.log(`[ledger] ${repoName} already published; skipping.`);
      return;
    }
    throw err;
  }
}

/** Return the set of repoNames already in PUBLISHED status (for dedupe). */
export async function listPublishedNames(): Promise<string[]> {
  const { Items } = await docClient.send(
    new ScanCommand({
      TableName: tableName(),
      FilterExpression: "#status = :published",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":published": "PUBLISHED" },
      ProjectionExpression: "repoName",
    })
  );
  return (Items ?? []).map((i) => (i as PublicationRecord).repoName);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: PASS — all 4 assertions green.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/lib/ledger.ts src/diffpress/lib/ledger.test.ts
git commit -m "feat: add PublicationLifecycle ledger helper with tests"
```

---

## Task 4: S3 payload store (`lib/payloadStore.ts`)

**Files:**
- Create: `src/diffpress/lib/payloadStore.ts`

(No unit test: this file is a thin AWS-SDK wrapper with no branching logic. It is exercised by `tsc` and `sst diff`.)

- [ ] **Step 1: Write the implementation**

```ts
// src/diffpress/lib/payloadStore.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Resource } from "sst";
import type { EnrichmentPayload, PayloadLocation } from "../types";

const s3 = new S3Client({});

function bucketName(): string {
  return Resource.ContentPayloadBucket.name;
}

/** Store an enrichment payload as JSON and return its S3 location. */
export async function putPayload(
  key: string,
  payload: EnrichmentPayload
): Promise<PayloadLocation> {
  const bucket = bucketName();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: "application/json",
    })
  );
  return { bucket, key };
}

/** Read and parse an enrichment payload from S3. Throws if missing/unreadable. */
export async function getPayload(key: string): Promise<EnrichmentPayload> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucketName(), Key: key })
  );
  if (!res.Body) {
    throw new Error(`Enrichment payload not found at key: ${key}`);
  }
  const body = await res.Body.transformToString();
  return JSON.parse(body) as EnrichmentPayload;
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/lib/payloadStore.ts
git commit -m "feat: add S3 enrichment payload store helper"
```

---

## Task 5: DiscoverRepos handler — TDD on the dedupe filter

**Files:**
- Create: `src/diffpress/discoverRepos.ts`
- Test: `src/diffpress/discoverRepos.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/diffpress/discoverRepos.test.ts
import { describe, it, expect } from "vitest";
import { filterUnpublished } from "./discoverRepos";
import type { RepoCandidate } from "./types";

const candidate = (repoName: string): RepoCandidate => ({
  repoName,
  repoUrl: `https://github.com/${repoName}`,
  description: "",
  stars: 100,
  language: "TypeScript",
});

describe("filterUnpublished", () => {
  it("removes candidates whose repoName is already published", () => {
    const candidates = [candidate("a/one"), candidate("b/two"), candidate("c/three")];
    const result = filterUnpublished(candidates, ["b/two"]);
    expect(result.map((r) => r.repoName)).toEqual(["a/one", "c/three"]);
  });

  it("returns all candidates when nothing is published", () => {
    const candidates = [candidate("a/one")];
    expect(filterUnpublished(candidates, [])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/discoverRepos.test.ts`
Expected: FAIL — cannot resolve `./discoverRepos`.

- [ ] **Step 3: Write the implementation**

```ts
// src/diffpress/discoverRepos.ts
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { listPublishedNames } from "./lib/ledger";
import type { RepoCandidate, ContentEngineState } from "./types";

/** Pure: drop candidates already covered (PUBLISHED) in the ledger. */
export function filterUnpublished(
  candidates: RepoCandidate[],
  publishedNames: string[]
): RepoCandidate[] {
  const published = new Set(publishedNames);
  return candidates.filter((c) => !published.has(c.repoName));
}

/** Build the "emerging repos" search query: created in the last 30 days, popular. */
function emergingQuery(): string {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `created:>${since} stars:>50`;
}

export async function handler(): Promise<ContentEngineState> {
  const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });

  const { data } = await octokit.rest.search.repos({
    q: emergingQuery(),
    sort: "stars",
    order: "desc",
    per_page: 25,
  });

  const candidates: RepoCandidate[] = data.items.map((item) => ({
    repoName: item.full_name,
    repoUrl: item.html_url,
    description: item.description ?? "",
    stars: item.stargazers_count,
    language: item.language ?? null,
  }));

  const publishedNames = await listPublishedNames();
  const fresh = filterUnpublished(candidates, publishedNames);

  if (fresh.length === 0) {
    throw new Error("No un-published emerging repos found this cycle.");
  }

  const repo = fresh[0];
  console.log(`[discoverRepos] selected ${repo.repoName} from ${fresh.length} candidates`);
  return { repo, candidates: fresh };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/discoverRepos.test.ts`
Expected: PASS — both tests green.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/discoverRepos.ts src/diffpress/discoverRepos.test.ts
git commit -m "feat: add discoverRepos handler with dedupe filter + tests"
```

---

## Task 6: EnrichRepos handler (stub → S3)

**Files:**
- Create: `src/diffpress/enrichRepos.ts`

(No unit test: stub data + thin S3 write, covered by `tsc`/`sst diff`. The stub is the documented seam for the real Exa/Tavily + sentiment integration.)

- [ ] **Step 1: Write the implementation**

```ts
// src/diffpress/enrichRepos.ts
import { putPayload } from "./lib/payloadStore";
import type { ContentEngineState, EnrichmentPayload } from "./types";

/**
 * STUB: fetch repo documentation (Exa/Tavily) and HN/Reddit sentiment.
 * Replace this with real API calls; the return shape is the contract.
 */
async function gatherEnrichment(state: ContentEngineState): Promise<EnrichmentPayload> {
  const { repo } = state;
  return {
    repoName: repo.repoName,
    repoUrl: repo.repoUrl,
    documentation: `# ${repo.repoName}\n\n${repo.description}\n\n(stub documentation)`,
    sentiment: [
      { source: "stub", summary: "Placeholder sentiment summary.", score: 0 },
    ],
    generatedAt: new Date().toISOString(),
  };
}

/** S3 key for an enrichment payload; slashes in repoName are flattened. */
function payloadKey(repoName: string): string {
  const safe = repoName.replace(/\//g, "-");
  return `enrichment/${Date.now()}/${safe}.json`;
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  const payload = await gatherEnrichment(state);
  const location = await putPayload(payloadKey(state.repo.repoName), payload);
  console.log(`[enrichRepos] wrote payload to s3://${location.bucket}/${location.key}`);
  return { ...state, enrichment: location };
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/enrichRepos.ts
git commit -m "feat: add enrichRepos handler (stub + S3 payload write)"
```

---

## Task 7: SeedIdeas handler (Pinecone brain-dump)

**Files:**
- Create: `src/diffpress/seedIdeas.ts`

(No unit test: reuses already-tested `src/utils.ts` helpers; logic is a thin query + map with a stub fallback.)

- [ ] **Step 1: Write the implementation**

```ts
// src/diffpress/seedIdeas.ts
import { getEmbedding, queryPinecone } from "../utils";
import type { ContentEngineState, SeedIdea } from "./types";

const BRAIN_DUMP_INDEX = "brain-dump";

/** STUB: generate seed ideas when the index returns nothing. */
function generateSeedIdeas(state: ContentEngineState): SeedIdea[] {
  return [
    {
      id: `gen-${Date.now()}`,
      text: `Why ${state.repo.repoName} matters for ${state.repo.language ?? "developers"}.`,
      score: 1,
    },
  ];
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  const queryText = `${state.repo.repoName}: ${state.repo.description}`;
  const vector = await getEmbedding(queryText);
  const results = await queryPinecone(BRAIN_DUMP_INDEX, vector, 5);

  let seedIdeas: SeedIdea[] = (results.matches ?? []).map((m) => ({
    id: m.id,
    text: String(m.metadata?.text ?? m.metadata?.title ?? ""),
    score: m.score ?? 0,
  }));

  if (seedIdeas.length === 0) {
    console.log("[seedIdeas] no matches in brain-dump; generating fallback ideas");
    seedIdeas = generateSeedIdeas(state);
  }

  return { ...state, seedIdeas };
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/seedIdeas.ts
git commit -m "feat: add seedIdeas handler querying brain-dump index"
```

---

## Task 8: NotifyHandoff handler (the paused task)

**Files:**
- Create: `src/diffpress/notifyHandoff.ts`

(No unit test: persists a ledger item + logs; the ledger param-building is already tested in Task 3.)

- [ ] **Step 1: Write the implementation**

The AwaitHandoff task invokes this Lambda with `{ taskToken, state }` (see Task 12 for the JSONata payload). It logs the token + S3 location and writes the `AWAITING_HANDOFF` ledger item so the frontend can retrieve the pending handoff. The Step Functions execution stays paused regardless of this Lambda's return value.

```ts
// src/diffpress/notifyHandoff.ts
import { putPending } from "./lib/ledger";
import type { ContentEngineState } from "./types";

interface NotifyHandoffEvent {
  taskToken: string;
  state: ContentEngineState;
}

export async function handler(event: NotifyHandoffEvent): Promise<{ ok: true }> {
  const { taskToken, state } = event;
  const payloadKey = state.enrichment?.key;

  console.log(
    `[notifyHandoff] AWAITING HANDOFF repo=${state.repo.repoName} ` +
      `payloadKey=${payloadKey} taskToken=${taskToken}`
  );

  await putPending({
    repoName: state.repo.repoName,
    status: "AWAITING_HANDOFF",
    repoUrl: state.repo.repoUrl,
    taskToken,
    payloadKey,
    discoveredAt: new Date().toISOString(),
  });

  return { ok: true };
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/notifyHandoff.ts
git commit -m "feat: add notifyHandoff handler persisting pending handoff"
```

---

## Task 9: PublishHandoff API handler — TDD on validation

**Files:**
- Create: `src/diffpress/publishHandoff.ts`
- Test: `src/diffpress/publishHandoff.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/diffpress/publishHandoff.test.ts
import { describe, it, expect } from "vitest";
import { parseHandoffEvent } from "./publishHandoff";

function event(opts: { sub?: string; body?: unknown }) {
  return {
    requestContext: {
      authorizer: opts.sub ? { jwt: { claims: { sub: opts.sub } } } : undefined,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  } as any;
}

describe("parseHandoffEvent", () => {
  it("rejects requests with no authenticated user (401)", () => {
    const r = parseHandoffEvent(event({ body: { taskToken: "t", repoUrl: "u", developerLog: "l" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(401);
  });

  it("rejects a missing body (400)", () => {
    const r = parseHandoffEvent(event({ sub: "user-1" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("rejects when required fields are missing (400)", () => {
    const r = parseHandoffEvent(event({ sub: "user-1", body: { taskToken: "t" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("accepts a valid request", () => {
    const r = parseHandoffEvent(
      event({ sub: "user-1", body: { taskToken: "tok", repoUrl: "https://x", developerLog: "# log" } })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.taskToken).toBe("tok");
      expect(r.value.repoUrl).toBe("https://x");
      expect(r.value.developerLog).toBe("# log");
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/publishHandoff.test.ts`
Expected: FAIL — cannot resolve `./publishHandoff`.

- [ ] **Step 3: Write the implementation**

```ts
// src/diffpress/publishHandoff.ts
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const sfn = new SFNClient({});

export interface ParsedHandoff {
  taskToken: string;
  repoUrl: string;
  developerLog: string;
}

export type ParseResult =
  | { ok: true; value: ParsedHandoff }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + body. No AWS calls. */
export function parseHandoffEvent(event: APIGatewayProxyEventV2): ParseResult {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return { ok: false, statusCode: 401, message: "Unauthorized" };
  }
  if (!event.body) {
    return { ok: false, statusCode: 400, message: "Missing request body" };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body" };
  }
  const { taskToken, repoUrl, developerLog } = parsed ?? {};
  if (
    typeof taskToken !== "string" ||
    typeof repoUrl !== "string" ||
    typeof developerLog !== "string"
  ) {
    return {
      ok: false,
      statusCode: 400,
      message: "taskToken, repoUrl and developerLog are required strings",
    };
  }
  return { ok: true, value: { taskToken, repoUrl, developerLog } };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseHandoffEvent(event);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: JSON.stringify({ message: parsed.message }) };
  }

  const { taskToken, repoUrl, developerLog } = parsed.value;
  try {
    await sfn.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ repoUrl, developerLog }),
      })
    );
    return { statusCode: 202, body: JSON.stringify({ message: "Workflow resumed." }) };
  } catch (error: any) {
    console.error("[publishHandoff] SendTaskSuccess failed:", error);
    // An invalid/expired token is a client problem; surface as 400.
    if (error?.name === "TaskDoesNotExist" || error?.name === "InvalidToken") {
      return { statusCode: 400, body: JSON.stringify({ message: "Invalid or expired task token." }) };
    }
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to resume workflow." }) };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/publishHandoff.test.ts`
Expected: PASS — all 4 cases green.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/publishHandoff.ts src/diffpress/publishHandoff.test.ts
git commit -m "feat: add publishHandoff API handler with validation + tests"
```

---

## Task 10: DraftArticle handler (read S3 → article stub)

**Files:**
- Create: `src/diffpress/draftArticle.ts`

(No unit test: thin S3 read + stub composition; covered by `tsc`/`sst diff`. This is the LLM drafting seam.)

- [ ] **Step 1: Write the implementation**

```ts
// src/diffpress/draftArticle.ts
import { getPayload } from "./lib/payloadStore";
import type { ContentEngineState, DraftedArticle } from "./types";

/**
 * STUB: combine enrichment docs, the repo URL, and the developer log into an article.
 * Replace the body with a real LLM call; the return shape is the contract.
 */
function composeArticle(
  docs: string,
  repoUrl: string,
  developerLog: string,
  repoName: string
): DraftedArticle {
  return {
    title: `A Critical Read of ${repoName}`,
    articleMarkdown: [
      `# A Critical Read of ${repoName}`,
      ``,
      `Source: ${repoUrl}`,
      ``,
      `## Background`,
      docs,
      ``,
      `## Developer Log`,
      developerLog,
    ].join("\n"),
    draftedAt: new Date().toISOString(),
  };
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  if (!state.enrichment?.key) {
    throw new Error("draftArticle: missing enrichment payload location in state.");
  }
  if (!state.handoff) {
    throw new Error("draftArticle: missing handoff data in state.");
  }

  const payload = await getPayload(state.enrichment.key);
  const article = composeArticle(
    payload.documentation,
    state.handoff.repoUrl,
    state.handoff.developerLog,
    state.repo.repoName
  );

  console.log(`[draftArticle] drafted "${article.title}"`);
  return { ...state, article };
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/draftArticle.ts
git commit -m "feat: add draftArticle handler (stub) reading S3 payload"
```

---

## Task 11: RecordPublication handler (ledger → PUBLISHED)

**Files:**
- Create: `src/diffpress/recordPublication.ts`

(No unit test: `markPublished` and its idempotency are tested in Task 3.)

- [ ] **Step 1: Write the implementation**

```ts
// src/diffpress/recordPublication.ts
import { markPublished } from "./lib/ledger";
import type { ContentEngineState } from "./types";

export async function handler(
  state: ContentEngineState
): Promise<{ repoName: string; status: "PUBLISHED" }> {
  if (!state.article) {
    throw new Error("recordPublication: missing drafted article in state.");
  }

  await markPublished(state.repo.repoName, {
    title: state.article.title,
    publishedAt: new Date().toISOString(),
  });

  console.log(`[recordPublication] ledger updated: ${state.repo.repoName} -> PUBLISHED`);
  return { repoName: state.repo.repoName, status: "PUBLISHED" };
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/recordPublication.ts
git commit -m "feat: add recordPublication handler updating the ledger"
```

---

## Task 12: Trigger handler (cron + manual HTTP)

**Files:**
- Create: `src/diffpress/trigger.ts`

(No unit test: thin StartExecution wrapper, mirrors `src/librarian/trigger.ts`.)

- [ ] **Step 1: Write the implementation**

Used both by the weekly cron job (invoked with an EventBridge event) and the manual `url: true` function (invoked with an HTTP request). It ignores its input and starts a fresh execution, returning an HTTP-shaped result.

```ts
// src/diffpress/trigger.ts
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { Resource } from "sst";

const sfn = new SFNClient({});

export async function handler(): Promise<{ statusCode: number; body: string }> {
  try {
    const res = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: Resource.ContentEngine.arn,
        input: "{}",
      })
    );
    console.log("[trigger] started ContentEngine:", res.executionArn);
    return {
      statusCode: 202,
      body: JSON.stringify({ message: "ContentEngine started", executionArn: res.executionArn }),
    };
  } catch (error) {
    console.error("[trigger] failed to start ContentEngine:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to start ContentEngine", error: message }) };
  }
}
```

- [ ] **Step 2: Type-check and commit**

Run: `npx tsc --noEmit`
Expected: PASS
```bash
git add src/diffpress/trigger.ts
git commit -m "feat: add ContentEngine trigger handler (cron + manual)"
```

---

## Task 13: Wire the infrastructure in `sst.config.ts`

**Files:**
- Modify: `sst.config.ts`

All additions go inside the existing `run()` function. Insert the new resource block **after** the `dreamer` Cron definition (around line 375) and **before** the `return { ... }` statement. The new `api.route` must be added where the other `api.route(...)` calls live (after the existing `GET /dashboard` route, ~line 356). Reuse the existing `api`, `auth`, `authorizer`, and the existing secrets.

- [ ] **Step 1: Add the Content Engine resources block**

Insert before `return {` (after the `dreamer` Cron):

```ts
    // ===== DIFFPRESS CONTENT ENGINE =====

    // Phase 1 enrichment payloads
    const contentPayloadBucket = new sst.aws.Bucket("ContentPayloadBucket");

    // Publication ledger (PK: repoName), lifecycle: AWAITING_HANDOFF -> PUBLISHED
    const publicationLifecycle = new sst.aws.Dynamo("PublicationLifecycle", {
      fields: { repoName: "string" },
      primaryIndex: { hashKey: "repoName" },
    });

    const contentEngineFns = {
      discoverRepos: new sst.aws.Function("DiffPressDiscoverRepos", {
        handler: "src/diffpress/discoverRepos.handler",
        link: [GITHUB_TOKEN, publicationLifecycle],
        timeout: "30 seconds",
      }),
      enrichRepos: new sst.aws.Function("DiffPressEnrichRepos", {
        handler: "src/diffpress/enrichRepos.handler",
        link: [contentPayloadBucket],
        timeout: "60 seconds",
      }),
      seedIdeas: new sst.aws.Function("DiffPressSeedIdeas", {
        handler: "src/diffpress/seedIdeas.handler",
        link: [GEMINI_API_KEY, PINECONE_API_KEY],
        timeout: "60 seconds",
      }),
      notifyHandoff: new sst.aws.Function("DiffPressNotifyHandoff", {
        handler: "src/diffpress/notifyHandoff.handler",
        link: [publicationLifecycle],
        timeout: "30 seconds",
      }),
      draftArticle: new sst.aws.Function("DiffPressDraftArticle", {
        handler: "src/diffpress/draftArticle.handler",
        link: [GEMINI_API_KEY, contentPayloadBucket],
        timeout: "60 seconds",
      }),
      recordPublication: new sst.aws.Function("DiffPressRecordPublication", {
        handler: "src/diffpress/recordPublication.handler",
        link: [publicationLifecycle],
        timeout: "30 seconds",
      }),
    };

    // ----- State machine definition -----
    const discoverState = sst.aws.StepFunctions.lambdaInvoke({
      name: "DiscoverRepos",
      function: contentEngineFns.discoverRepos,
      output: "{% $states.result.Payload %}",
    });

    const enrichState = sst.aws.StepFunctions.lambdaInvoke({
      name: "EnrichRepos",
      function: contentEngineFns.enrichRepos,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });

    const seedState = sst.aws.StepFunctions.lambdaInvoke({
      name: "SeedIdeas",
      function: contentEngineFns.seedIdeas,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });

    // Phase 2: paused wait-for-task-token state.
    const awaitHandoffState = sst.aws.StepFunctions.lambdaInvoke({
      name: "AwaitHandoff",
      function: contentEngineFns.notifyHandoff,
      integration: "token",
      payload: {
        taskToken: "{% $states.context.Task.Token %}",
        state: "{% $states.input %}",
      },
      // Preserve pre-pause state and merge in the resume payload (repoUrl + developerLog).
      output: "{% $merge([$states.input, { 'handoff': $states.result }]) %}",
    });

    const draftState = sst.aws.StepFunctions.lambdaInvoke({
      name: "DraftArticle",
      function: contentEngineFns.draftArticle,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });

    const recordState = sst.aws.StepFunctions.lambdaInvoke({
      name: "RecordPublication",
      function: contentEngineFns.recordPublication,
      payload: "{% $states.input %}",
    });

    const contentEngineDefinition = discoverState
      .next(enrichState)
      .next(seedState)
      .next(awaitHandoffState)
      .next(draftState)
      .next(recordState);

    const contentEngine = new sst.aws.StepFunctions("ContentEngine", {
      definition: contentEngineDefinition,
    });

    // Manual HTTP trigger (mirrors LibrarianTrigger)
    const contentEngineTrigger = new sst.aws.Function("ContentEngineTrigger", {
      handler: "src/diffpress/trigger.handler",
      url: true,
      link: [contentEngine],
      permissions: [
        { actions: ["states:StartExecution"], resources: [contentEngine.arn] },
      ],
    });

    // Weekly cron — same handler, StartExecution permission.
    const contentEngineCron = new sst.aws.Cron("ContentEngineCron", {
      schedule: "rate(7 days)",
      job: {
        handler: "src/diffpress/trigger.handler",
        link: [contentEngine],
        permissions: [
          { actions: ["states:StartExecution"], resources: [contentEngine.arn] },
        ],
      },
    });
```

- [ ] **Step 2: Add the handoff API route**

Add after the existing `GET /dashboard` route block (it must come before `// DEPLOY FRONTEND`). `states:SendTaskSuccess`/`SendTaskFailure` use resource `*` because task tokens are not ARN-addressable.

```ts
    api.route("POST /api/publish-handoff", {
      handler: "src/diffpress/publishHandoff.handler",
      link: [auth, publicationLifecycle],
      permissions: [
        { actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: ["*"] },
      ],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });
```

- [ ] **Step 3: Add outputs**

In the `return { ... }` object, add these fields:

```ts
      contentEngineTrigger: contentEngineTrigger.url,
      publicationTable: publicationLifecycle.name,
      contentPayloadBucket: contentPayloadBucket.name,
```

- [ ] **Step 4: Type-check the config**

Run: `npx tsc --noEmit`
Expected: PASS — config references resolve (`contentEngine.arn`, `publicationLifecycle.name`, etc.).

- [ ] **Step 5: Commit**

```bash
git add sst.config.ts
git commit -m "feat: wire DiffPress Content Engine infra (SFN, bucket, table, cron, API)"
```

---

## Task 14: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run all unit tests**

Run: `npm test`
Expected: PASS — ledger (Task 3), discoverRepos (Task 5), publishHandoff (Task 9) suites all green.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: PASS — no errors anywhere.

- [ ] **Step 3: Validate the SST resource graph**

Run: `npx sst diff --stage dev`
Expected: SST builds the graph and prints a plan that includes: `ContentPayloadBucket`, `PublicationLifecycle`, the six `DiffPress*` functions, `ContentEngine` (state machine), `ContentEngineTrigger`, `ContentEngineCron`, and the new `POST /api/publish-handoff` route — with no synthesis/link/permission errors.

> If `sst diff` requires AWS credentials/secrets that aren't available in the working environment, the acceptance fallback is that `sst diff` proceeds past graph synthesis (resources resolve) — credential/secret errors at the AWS API call stage are environmental, not plan defects. Note any such stop point in the execution log.

- [ ] **Step 4: Final commit (if any uncommitted verification fixes)**

```bash
git add -A
git commit -m "chore: verification fixes for DiffPress Content Engine" || echo "nothing to commit"
```

---

## Self-Review Notes (for the planner)

- **Spec coverage:** Phase 1 (Tasks 5–7), Phase 2 wait/token (Tasks 8, 12-step-1 JSONata), Phase 3 webhook (Task 9 + Task 13 route), Phase 4 drafting + ledger (Tasks 10–11), infra/cron/IAM (Tasks 1, 13), tests + verification (Tasks 3/5/9, 14). All spec sections map to a task.
- **State threading:** every task uses `ContentEngineState`; `payload: "{% $states.input %}"` + `output: "{% $states.result.Payload %}"` thread the full object; `AwaitHandoff` uses `$merge` to survive the pause. Consistent across Tasks 5–11 and 13.
- **Naming consistency:** `filterUnpublished`, `parseHandoffEvent`, `buildPendingPutParams`, `buildMarkPublishedParams`, `isAlreadyPublishedError`, `putPending`, `markPublished`, `listPublishedNames`, `putPayload`, `getPayload` — all defined once and referenced with the same names in tests and handlers.
- **No placeholders:** every code step contains complete code; stubs (`gatherEnrichment`, `generateSeedIdeas`, `composeArticle`) are intentional, fully-written integration seams, not plan gaps.
