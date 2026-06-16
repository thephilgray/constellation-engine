# DiffPress Real Discovery & Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mock Discovery and Drafting columns with real DynamoDB-backed pipeline state, so the `/diffpress` board reflects only genuine pipeline runs.

**Architecture:** The background Step Function writes deduped GitHub candidates to the `PublicationLifecycle` ledger as `DISCOVERED` (Model A); the selected repo advances `DISCOVERED → AWAITING_HANDOFF → DRAFTING → PUBLISHED`. The UI never calls GitHub — it reads all four columns from `GET /api/handoffs`, which queries a new `status-index` GSI (no table scan). Dedup uses `BatchGetItem`. `DISCOVERED` rows self-expire via a 30-day TTL.

**Tech Stack:** TypeScript, SST v3 (Ion, 3.17.12), DynamoDB (`@aws-sdk/lib-dynamodb`), Octokit, AWS Step Functions, React/Zustand frontend, Vitest.

**Reference spec:** `docs/superpowers/specs/2026-06-15-diffpress-real-discovery-design.md`

---

## File Structure

**Backend (`src/diffpress/`)**
- `types.ts` — add `DISCOVERED`/`DRAFTING` statuses; extend `PublicationRecord` + `RepoCandidate` with discovery fields. (modify)
- `lib/ledger.ts` — add `buildMarkDraftingParams`/`markDrafting`, `buildMarkAwaitingParams`/`markAwaitingHandoff`, `batchGetExisting`, `batchPutDiscovered`, `queryByStatus`; rewrite `listBoardItems` to Query the GSI. (modify)
- `discoverRepos.ts` — replace scan-based `filterUnpublished` with `dedupeByExisting`; write `DISCOVERED` rows. (modify)
- `notifyHandoff.ts` — flip the existing `DISCOVERED` row to `AWAITING_HANDOFF` (Update, not Put). (modify)
- `draftArticle.ts` — call `markDrafting` at handler start. (modify)
- `listHandoffs.ts` — four-column `bucketBoard` + `Board` type. (modify)
- `sst.config.ts` — add `status` field, `status-index` GSI, `ttl`; link table to `draftArticle`. (modify)

**Frontend (`src/components/diffpress/`)**
- `types.ts` — update `DiscoveryCard`, `DraftingCard`, `HandoffsResponse`. (modify)
- `services.ts` — map all four columns from `/api/handoffs`; drop `PIPELINE`. (modify)
- `store.ts` — empty initial pipeline. (modify)
- `Dashboard.tsx` — render real discovery/drafting fields. (modify)
- `data.ts` — delete `PIPELINE`, `HANDOFFS`, `REVIEW_BLOCKS`. (modify)

**Post-deploy:** one-off deletion of stale ledger rows (data op).

---

## Task 1: Extend backend domain types

**Files:**
- Modify: `src/diffpress/types.ts`

- [ ] **Step 1: Add `pushedAt` to `RepoCandidate`**

In `src/diffpress/types.ts`, change the `RepoCandidate` interface to:

```ts
/** A candidate repository discovered from GitHub. */
export interface RepoCandidate {
  repoName: string; // "owner/name" — the ledger partition key
  repoUrl: string;
  description: string;
  stars: number;
  language: string | null;
  pushedAt: string; // GitHub `pushed_at` ISO timestamp
}
```

- [ ] **Step 2: Add the two new statuses**

Change `PublicationStatus`:

```ts
export type PublicationStatus =
  | "DISCOVERED"
  | "AWAITING_HANDOFF"
  | "DRAFTING"
  | "PUBLISHED";
```

- [ ] **Step 3: Extend `PublicationRecord` with discovery fields**

Add these optional fields to the `PublicationRecord` interface (keep existing fields):

```ts
/** An item in the PublicationLifecycle table (PK: repoName). */
export interface PublicationRecord {
  repoName: string;
  status: PublicationStatus;
  repoUrl?: string;
  taskToken?: string;
  payloadKey?: string;
  title?: string;
  articleMarkdown?: string;
  discoveredAt?: string;
  publishedAt?: string;
  // Discovery-pool fields (status === "DISCOVERED")
  description?: string;
  stars?: number;
  language?: string | null;
  pushedAt?: string;
  ttl?: number; // epoch seconds; DynamoDB TTL attribute
}
```

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors from `types.ts`; errors in callers that don't yet set `pushedAt` are addressed in later tasks — if any appear, note them and continue).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/types.ts
git commit -m "feat(diffpress): add DISCOVERED/DRAFTING statuses and discovery fields"
```

---

## Task 2: Ledger param-builders for DRAFTING and AWAITING_HANDOFF transitions

**Files:**
- Modify: `src/diffpress/lib/ledger.ts`
- Test: `src/diffpress/lib/ledger.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `src/diffpress/lib/ledger.test.ts`:

```ts
import {
  buildMarkDraftingParams,
  buildMarkAwaitingParams,
} from "./ledger";

describe("buildMarkDraftingParams", () => {
  it("builds a conditional UpdateCommand flipping status to DRAFTING", () => {
    const params = buildMarkDraftingParams("MyTable", "vercel/next.js");
    expect(params.TableName).toBe("MyTable");
    expect(params.Key).toEqual({ repoName: "vercel/next.js" });
    expect(params.ExpressionAttributeValues![":drafting"]).toBe("DRAFTING");
    // Do not resurrect a published item.
    expect(params.ConditionExpression).toContain("status");
  });
});

describe("buildMarkAwaitingParams", () => {
  it("builds an UpdateCommand carrying taskToken + payloadKey", () => {
    const params = buildMarkAwaitingParams("MyTable", "vercel/next.js", {
      repoUrl: "https://github.com/vercel/next.js",
      taskToken: "tok-9",
      payloadKey: "enrichment/exec-1/vercel-next.js.json",
    });
    expect(params.Key).toEqual({ repoName: "vercel/next.js" });
    expect(params.ExpressionAttributeValues![":awaiting"]).toBe("AWAITING_HANDOFF");
    expect(params.ExpressionAttributeValues![":taskToken"]).toBe("tok-9");
    expect(params.UpdateExpression).toContain("taskToken = :taskToken");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: FAIL — `buildMarkDraftingParams`/`buildMarkAwaitingParams` are not exported.

- [ ] **Step 3: Implement the param-builders**

In `src/diffpress/lib/ledger.ts`, after `buildMarkPublishedParams`, add:

```ts
/** Pure: flip an item to DRAFTING (only if not already PUBLISHED). */
export function buildMarkDraftingParams(
  table: string,
  repoName: string
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression: "SET #status = :drafting",
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":drafting": "DRAFTING", ":published": "PUBLISHED" },
  };
}

/** Pure: flip a DISCOVERED item to AWAITING_HANDOFF, attaching resume metadata. */
export function buildMarkAwaitingParams(
  table: string,
  repoName: string,
  meta: { repoUrl: string; taskToken: string; payloadKey?: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression:
      "SET #status = :awaiting, repoUrl = :repoUrl, taskToken = :taskToken, payloadKey = :payloadKey, discoveredAt = if_not_exists(discoveredAt, :now)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":awaiting": "AWAITING_HANDOFF",
      ":repoUrl": meta.repoUrl,
      ":taskToken": meta.taskToken,
      ":payloadKey": meta.payloadKey ?? null,
      ":now": new Date().toISOString(),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/lib/ledger.ts src/diffpress/lib/ledger.test.ts
git commit -m "feat(diffpress): add DRAFTING and AWAITING_HANDOFF update builders"
```

---

## Task 3: Ledger runtime helpers — markDrafting, markAwaitingHandoff, batch dedup/write, GSI query

**Files:**
- Modify: `src/diffpress/lib/ledger.ts`

These wrap the AWS SDK and are exercised via handler tests later; this task adds them and keeps `tsc` green.

- [ ] **Step 1: Add the new SDK imports**

In `src/diffpress/lib/ledger.ts`, extend the `@aws-sdk/lib-dynamodb` import to include batch + query commands:

```ts
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  QueryCommand,
  BatchGetCommand,
  BatchWriteCommand,
  type PutCommandInput,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
```

- [ ] **Step 2: Add the GSI constant and runtime helpers**

Append to `src/diffpress/lib/ledger.ts`:

```ts
/** Name of the status GSI declared in sst.config.ts. */
export const STATUS_INDEX = "status-index";

/** Flip an item to DRAFTING. Swallows the conditional-check failure (idempotent). */
export async function markDrafting(repoName: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand(buildMarkDraftingParams(tableName(), repoName))
    );
  } catch (err) {
    if (isAlreadyPublishedError(err)) {
      console.log(`[ledger] ${repoName} already published; skip DRAFTING.`);
      return;
    }
    throw err;
  }
}

/** Flip a DISCOVERED item to AWAITING_HANDOFF with resume metadata. */
export async function markAwaitingHandoff(
  repoName: string,
  meta: { repoUrl: string; taskToken: string; payloadKey?: string }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildMarkAwaitingParams(tableName(), repoName, meta))
  );
}

/** BatchGetItem the given repoNames; return the set that already exist. */
export async function batchGetExisting(repoNames: string[]): Promise<Set<string>> {
  if (repoNames.length === 0) return new Set();
  const found = new Set<string>();
  // BatchGetItem caps at 100 keys per request.
  for (let i = 0; i < repoNames.length; i += 100) {
    const chunk = repoNames.slice(i, i + 100);
    const { Responses } = await docClient.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName()]: {
            Keys: chunk.map((repoName) => ({ repoName })),
            ProjectionExpression: "repoName",
          },
        },
      })
    );
    for (const item of Responses?.[tableName()] ?? []) {
      found.add((item as PublicationRecord).repoName);
    }
  }
  return found;
}

/** BatchWriteItem the given records (PutRequests). Chunks at 25 per request. */
export async function batchPutDiscovered(records: PublicationRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 25) {
    const chunk = records.slice(i, i + 25);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName()]: chunk.map((Item) => ({ PutRequest: { Item } })),
        },
      })
    );
  }
}

/** Query the status GSI for every item with the given status. */
export async function queryByStatus(status: string): Promise<PublicationRecord[]> {
  const { Items } = await docClient.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: STATUS_INDEX,
      KeyConditionExpression: "#status = :s",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":s": status },
      ProjectionExpression:
        "repoName, #status, repoUrl, taskToken, discoveredAt, title, publishedAt, description, stars, #lang, pushedAt",
    })
  );
  return (Items ?? []) as PublicationRecord[];
}
```

Note: `language` is a DynamoDB reserved word, so add it to the names map. Update the `queryByStatus` `ExpressionAttributeNames` to:

```ts
      ExpressionAttributeNames: { "#status": "status", "#lang": "language" },
```

- [ ] **Step 3: Rewrite `listBoardItems` to query the GSI instead of scanning**

Replace the existing `listBoardItems` function body with:

```ts
/**
 * Read the board via per-status Queries on the status GSI (no table scan).
 * Projects out `articleMarkdown` (fetched on demand) to keep the payload light.
 */
export async function listBoardItems(): Promise<PublicationRecord[]> {
  const statuses = ["DISCOVERED", "AWAITING_HANDOFF", "DRAFTING", "PUBLISHED"];
  const groups = await Promise.all(statuses.map((s) => queryByStatus(s)));
  return groups.flat();
}
```

- [ ] **Step 4: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Verify existing ledger tests still pass**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/lib/ledger.ts
git commit -m "feat(diffpress): ledger helpers for batch dedup, discovery writes, GSI query"
```

---

## Task 4: Discovery writes the candidate pool (BatchGetItem dedup + DISCOVERED rows)

**Files:**
- Modify: `src/diffpress/discoverRepos.ts`
- Test: `src/diffpress/discoverRepos.test.ts`

- [ ] **Step 1: Replace the test for the new pure helper**

Replace the entire contents of `src/diffpress/discoverRepos.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { dedupeByExisting, toDiscoveredRecord } from "./discoverRepos";
import type { RepoCandidate } from "./types";

const candidate = (repoName: string): RepoCandidate => ({
  repoName,
  repoUrl: `https://github.com/${repoName}`,
  description: "desc",
  stars: 100,
  language: "TypeScript",
  pushedAt: "2026-06-10T00:00:00.000Z",
});

describe("dedupeByExisting", () => {
  it("drops candidates whose repoName already exists in the ledger", () => {
    const candidates = [candidate("a/one"), candidate("b/two"), candidate("c/three")];
    const result = dedupeByExisting(candidates, new Set(["b/two"]));
    expect(result.map((r) => r.repoName)).toEqual(["a/one", "c/three"]);
  });

  it("returns all candidates when nothing exists yet", () => {
    expect(dedupeByExisting([candidate("a/one")], new Set())).toHaveLength(1);
  });
});

describe("toDiscoveredRecord", () => {
  it("maps a candidate to a DISCOVERED ledger record with a TTL", () => {
    const now = 1_780_000_000_000; // fixed epoch ms
    const rec = toDiscoveredRecord(candidate("a/one"), now);
    expect(rec.status).toBe("DISCOVERED");
    expect(rec.repoName).toBe("a/one");
    expect(rec.stars).toBe(100);
    expect(rec.language).toBe("TypeScript");
    expect(rec.pushedAt).toBe("2026-06-10T00:00:00.000Z");
    // 30 days in seconds past `now`.
    expect(rec.ttl).toBe(Math.floor(now / 1000) + 30 * 24 * 60 * 60);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diffpress/discoverRepos.test.ts`
Expected: FAIL — `dedupeByExisting`/`toDiscoveredRecord` not exported.

- [ ] **Step 3: Rewrite `discoverRepos.ts`**

Replace the entire contents of `src/diffpress/discoverRepos.ts` with:

```ts
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { batchGetExisting, batchPutDiscovered } from "./lib/ledger";
import type { RepoCandidate, ContentEngineState, PublicationRecord } from "./types";

const DISCOVERY_TTL_DAYS = 30;

/** Pure: drop candidates already present in the ledger (any status). */
export function dedupeByExisting(
  candidates: RepoCandidate[],
  existing: Set<string>
): RepoCandidate[] {
  return candidates.filter((c) => !existing.has(c.repoName));
}

/** Pure: map a fresh candidate to a DISCOVERED ledger row with a 30-day TTL. */
export function toDiscoveredRecord(
  c: RepoCandidate,
  nowMs: number
): PublicationRecord {
  return {
    repoName: c.repoName,
    status: "DISCOVERED",
    repoUrl: c.repoUrl,
    description: c.description,
    stars: c.stars,
    language: c.language,
    pushedAt: c.pushedAt,
    discoveredAt: new Date(nowMs).toISOString(),
    ttl: Math.floor(nowMs / 1000) + DISCOVERY_TTL_DAYS * 24 * 60 * 60,
  };
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
    per_page: 50,
  });

  const candidates: RepoCandidate[] = data.items.map((item) => ({
    repoName: item.full_name,
    repoUrl: item.html_url,
    description: item.description ?? "",
    stars: item.stargazers_count,
    language: item.language ?? null,
    pushedAt: item.pushed_at ?? new Date().toISOString(),
  }));

  // Dedup against the whole ledger via BatchGetItem (no table scan).
  const existing = await batchGetExisting(candidates.map((c) => c.repoName));
  const fresh = dedupeByExisting(candidates, existing);

  if (fresh.length === 0) {
    throw new Error("No un-seen emerging repos found this cycle.");
  }

  // Persist the whole fresh pool as DISCOVERED so the UI can show it.
  const now = Date.now();
  await batchPutDiscovered(fresh.map((c) => toDiscoveredRecord(c, now)));

  const repo = fresh[0];
  console.log(`[discoverRepos] wrote ${fresh.length} DISCOVERED; selected ${repo.repoName}`);
  return { repo, candidates: fresh };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/diffpress/discoverRepos.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/discoverRepos.ts src/diffpress/discoverRepos.test.ts
git commit -m "feat(diffpress): discovery writes deduped candidate pool as DISCOVERED"
```

---

## Task 5: notifyHandoff flips DISCOVERED → AWAITING_HANDOFF (Update, not Put)

**Files:**
- Modify: `src/diffpress/notifyHandoff.ts`

The selected repo already has a `DISCOVERED` row (Task 4). Update it in place rather than overwriting, so discovery metadata is preserved.

- [ ] **Step 1: Rewrite `notifyHandoff.ts`**

Replace the contents of `src/diffpress/notifyHandoff.ts` with:

```ts
import { markAwaitingHandoff } from "./lib/ledger";
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

  await markAwaitingHandoff(state.repo.repoName, {
    repoUrl: state.repo.repoUrl,
    taskToken,
    payloadKey,
  });

  return { ok: true };
}
```

- [ ] **Step 2: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS. (`state.enrichment?.key` is typed; confirm `ContentEngineState.enrichment` has a `key` — it is `PayloadLocation` with `bucket`/`key`. ✓)

- [ ] **Step 3: Verify full backend tests still pass**

Run: `npx vitest run src/diffpress`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/diffpress/notifyHandoff.ts
git commit -m "feat(diffpress): notifyHandoff updates DISCOVERED row to AWAITING_HANDOFF"
```

---

## Task 6: draftArticle marks DRAFTING at handler start

**Files:**
- Modify: `src/diffpress/draftArticle.ts`

- [ ] **Step 1: Import `markDrafting`**

In `src/diffpress/draftArticle.ts`, add to the imports (after the `payloadStore`/`devNotes` imports):

```ts
import { markDrafting } from "./lib/ledger";
```

- [ ] **Step 2: Call `markDrafting` at the top of `handler`**

In the `handler` function, immediately after the two `if (!state...)` guard blocks and before `const payload = await getPayload(...)`, insert:

```ts
  // Surface this repo in the Drafting column while the model runs.
  await markDrafting(state.repo.repoName);
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify draftArticle tests still pass**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: PASS. (The existing tests exercise the pure `buildDraftPrompt`/`parseDraftResponse`; the handler isn't invoked there, so no AWS mock is needed.)

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/draftArticle.ts
git commit -m "feat(diffpress): mark repo DRAFTING when article drafting begins"
```

---

## Task 7: Four-column board bucketing

**Files:**
- Modify: `src/diffpress/listHandoffs.ts`
- Test: `src/diffpress/listHandoffs.test.ts`

- [ ] **Step 1: Replace the test file**

Replace the entire contents of `src/diffpress/listHandoffs.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { bucketBoard } from "./listHandoffs";
import type { PublicationRecord } from "./types";

describe("bucketBoard", () => {
  const items: PublicationRecord[] = [
    {
      repoName: "tau/agentmesh",
      status: "DISCOVERED",
      repoUrl: "https://github.com/tau/agentmesh",
      description: "A message bus for multi-agent systems.",
      stars: 900,
      language: "Go",
      pushedAt: "2026-06-12T00:00:00.000Z",
    },
    {
      repoName: "forge/sigil",
      status: "AWAITING_HANDOFF",
      repoUrl: "https://github.com/forge/sigil",
      taskToken: "tok-1",
      discoveredAt: "2026-06-15T00:00:00.000Z",
    },
    {
      repoName: "cortex/orchard",
      status: "DRAFTING",
      description: "Synthesizing the draft.",
    },
    {
      repoName: "vercel/next.js",
      status: "PUBLISHED",
      title: "Inside Next.js",
      publishedAt: "2026-06-15T01:00:00.000Z",
    },
  ];

  it("routes DISCOVERED items to discovered with their GitHub metadata", () => {
    const board = bucketBoard(items);
    expect(board.discovered).toHaveLength(1);
    expect(board.discovered[0].repoName).toBe("tau/agentmesh");
    expect(board.discovered[0].stars).toBe(900);
    expect(board.discovered[0].language).toBe("Go");
  });

  it("routes AWAITING_HANDOFF items to readyForDev with their task token", () => {
    const board = bucketBoard(items);
    expect(board.readyForDev).toHaveLength(1);
    expect(board.readyForDev[0].taskToken).toBe("tok-1");
  });

  it("routes DRAFTING items to drafting", () => {
    const board = bucketBoard(items);
    expect(board.drafting).toHaveLength(1);
    expect(board.drafting[0].repoName).toBe("cortex/orchard");
  });

  it("routes PUBLISHED items to inReview without exposing a task token", () => {
    const board = bucketBoard(items);
    expect(board.inReview).toHaveLength(1);
    expect(board.inReview[0].title).toBe("Inside Next.js");
    expect(board.inReview[0]).not.toHaveProperty("taskToken");
  });

  it("ignores unknown statuses", () => {
    const board = bucketBoard([{ repoName: "x/y", status: "WEIRD" as any }]);
    expect(board.discovered).toHaveLength(0);
    expect(board.readyForDev).toHaveLength(0);
    expect(board.drafting).toHaveLength(0);
    expect(board.inReview).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diffpress/listHandoffs.test.ts`
Expected: FAIL — `board.discovered`/`board.drafting` don't exist.

- [ ] **Step 3: Rewrite the types and `bucketBoard` in `listHandoffs.ts`**

In `src/diffpress/listHandoffs.ts`, replace everything from the `HandoffItem` interface through the end of `bucketBoard` with:

```ts
export interface DiscoveredItem {
  repoName: string;
  repoUrl?: string;
  description?: string;
  stars?: number;
  language?: string | null;
  pushedAt?: string;
}

export interface HandoffItem {
  repoName: string;
  repoUrl?: string;
  taskToken?: string;
  discoveredAt?: string;
}

export interface DraftingItem {
  repoName: string;
  description?: string;
}

export interface ReviewItem {
  repoName: string;
  title?: string;
  publishedAt?: string;
}

export interface Board {
  discovered: DiscoveredItem[];
  readyForDev: HandoffItem[];
  drafting: DraftingItem[];
  inReview: ReviewItem[];
}

/** Pure: split ledger items into the four board columns the UI renders. */
export function bucketBoard(items: PublicationRecord[]): Board {
  const board: Board = { discovered: [], readyForDev: [], drafting: [], inReview: [] };
  for (const item of items) {
    switch (item.status) {
      case "DISCOVERED":
        board.discovered.push({
          repoName: item.repoName,
          repoUrl: item.repoUrl,
          description: item.description,
          stars: item.stars,
          language: item.language,
          pushedAt: item.pushedAt,
        });
        break;
      case "AWAITING_HANDOFF":
        board.readyForDev.push({
          repoName: item.repoName,
          repoUrl: item.repoUrl,
          taskToken: item.taskToken,
          discoveredAt: item.discoveredAt,
        });
        break;
      case "DRAFTING":
        board.drafting.push({
          repoName: item.repoName,
          description: item.description,
        });
        break;
      case "PUBLISHED":
        board.inReview.push({
          repoName: item.repoName,
          title: item.title,
          publishedAt: item.publishedAt,
        });
        break;
    }
  }
  return board;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/diffpress/listHandoffs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/listHandoffs.ts src/diffpress/listHandoffs.test.ts
git commit -m "feat(diffpress): bucket board into four DynamoDB-driven columns"
```

---

## Task 8: Infrastructure — status GSI, TTL, draftArticle table link

**Files:**
- Modify: `sst.config.ts`

- [ ] **Step 1: Add the GSI, status field, and TTL to the table**

In `sst.config.ts`, replace the `publicationLifecycle` definition (around line 364) with:

```ts
    // Publication ledger (PK: repoName). Lifecycle:
    // DISCOVERED -> AWAITING_HANDOFF -> DRAFTING -> PUBLISHED.
    const publicationLifecycle = new sst.aws.Dynamo("PublicationLifecycle", {
      fields: { repoName: "string", status: "string" },
      primaryIndex: { hashKey: "repoName" },
      globalIndexes: { "status-index": { hashKey: "status" } },
      ttl: "ttl",
    });
```

- [ ] **Step 2: Link the table to the draftArticle function**

In the `contentEngineFns` object (around line 452), change the `draftArticle` function's `link` to include `publicationLifecycle`:

```ts
      draftArticle: new sst.aws.Function("DiffPressDraftArticle", {
        handler: "src/diffpress/draftArticle.handler",
        link: [GEMINI_API_KEY, GITHUB_TOKEN, contentPayloadBucket, publicationLifecycle],
        timeout: "60 seconds",
      }),
```

- [ ] **Step 3: Verify the config typechecks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Verify the infra synthesizes**

Run: `npx sst diff --stage dev`
Expected: Synthesizes without error and shows the `status-index` GSI + TTL being added to `PublicationLifecycle`, and the new link on `DiffPressDraftArticle`.
Note: `sst diff` regenerates `sst-env.d.ts`. If it gets clobbered in a no-secrets context, restore with `git checkout -- sst-env.d.ts` (see the `sst-typegen-gotchas` memory).

- [ ] **Step 5: Commit**

```bash
git add sst.config.ts
git commit -m "feat(diffpress): add status GSI + TTL to ledger, link table to draftArticle"
```

---

## Task 9: Frontend types for real discovery/drafting cards

**Files:**
- Modify: `src/components/diffpress/types.ts`

- [ ] **Step 1: Replace `DiscoveryCard`**

In `src/components/diffpress/types.ts`, replace the `DiscoveryCard` interface with:

```ts
export interface DiscoveryCard {
  id: string;
  repo: string;
  desc: string;
  stars: number;
  language: string;
  lastUpdated: string; // ISO timestamp (GitHub pushed_at)
}
```

- [ ] **Step 2: Replace `DraftingCard`**

Replace the `DraftingCard` interface with:

```ts
export interface DraftingCard {
  id: string;
  repo: string;
  desc: string;
}
```

- [ ] **Step 3: Extend `HandoffsResponse`**

Replace the `HandoffsResponse` interface with:

```ts
export interface HandoffsResponse {
  discovered: {
    repoName: string;
    repoUrl?: string;
    description?: string;
    stars?: number;
    language?: string | null;
    pushedAt?: string;
  }[];
  readyForDev: {
    repoName: string;
    repoUrl?: string;
    taskToken?: string;
    discoveredAt?: string;
  }[];
  drafting: {
    repoName: string;
    description?: string;
  }[];
  inReview: {
    repoName: string;
    title?: string;
    publishedAt?: string;
  }[];
}
```

- [ ] **Step 4: Commit** (typecheck runs after the consuming code is updated, in Task 12)

```bash
git add src/components/diffpress/types.ts
git commit -m "feat(diffpress): frontend types for real discovery/drafting cards"
```

---

## Task 10: Service layer maps all four columns from the API

**Files:**
- Modify: `src/components/diffpress/services.ts`

- [ ] **Step 1: Drop the PIPELINE import**

In `src/components/diffpress/services.ts`, change the data import (line 9) from:

```ts
import { PIPELINE, TECH_EDITOR_NOTES } from "./data";
```

to:

```ts
import { TECH_EDITOR_NOTES } from "./data";
```

- [ ] **Step 2: Rewrite `fetchCandidates`**

Replace the `fetchCandidates` function body with:

```ts
export async function fetchCandidates(): Promise<PipelineData> {
  const res = await authedFetch("/api/handoffs");
  if (!res.ok) throw new Error(`Failed to load handoffs (${res.status})`);
  const board: HandoffsResponse = await res.json();
  return {
    discovery: board.discovered.map((d) => ({
      id: d.repoName,
      repo: d.repoName,
      desc: d.description ?? "",
      stars: d.stars ?? 0,
      language: d.language ?? "",
      lastUpdated: d.pushedAt ?? "",
    })),
    drafting: board.drafting.map((d) => ({
      id: d.repoName,
      repo: d.repoName,
      desc: d.description ?? "Drafting in progress.",
    })),
    readyForDev: board.readyForDev.map((h) => ({
      id: h.repoName,
      repo: h.repoName,
      desc: "Ready for a local-dev pass before drafting.",
      taskToken: h.taskToken,
      repoUrl: h.repoUrl,
    })),
    inReview: board.inReview.map((r) => ({
      id: r.repoName,
      title: r.title ?? r.repoName,
      repo: r.repoName,
      editable: true,
    })),
  };
}
```

- [ ] **Step 3: Update the doc comment above `fetchCandidates`**

Replace its JSDoc with:

```ts
/**
 * Load the pipeline board. All four columns come from the ledger via
 * `GET /api/handoffs` (status GSI); the UI never queries GitHub directly.
 */
```

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/services.ts
git commit -m "feat(diffpress): fetch all four board columns from the API"
```

---

## Task 11: Empty initial pipeline in the store

**Files:**
- Modify: `src/components/diffpress/store.ts`

- [ ] **Step 1: Drop PIPELINE from the data import**

In `src/components/diffpress/store.ts` (line 2), change:

```ts
import { ARTICLE_HTML, EMPTY_DEPLOY, PIPELINE, TECH_EDITOR_NOTES } from "./data";
```

to:

```ts
import { ARTICLE_HTML, EMPTY_DEPLOY, TECH_EDITOR_NOTES } from "./data";
```

- [ ] **Step 2: Seed an empty pipeline**

Replace line 128:

```ts
  pipeline: structuredClone(PIPELINE),
```

with:

```ts
  pipeline: { discovery: [], readyForDev: [], drafting: [], inReview: [] },
```

- [ ] **Step 3: Simplify the load-failure fallback**

In `loadPipeline`'s `catch` block, replace:

```ts
      set((s) => ({ pipeline: { ...s.pipeline, readyForDev: [], inReview: [] } }));
```

with:

```ts
      set({ pipeline: { discovery: [], readyForDev: [], drafting: [], inReview: [] } });
```

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/store.ts
git commit -m "feat(diffpress): seed an empty pipeline until the API loads"
```

---

## Task 12: Render real discovery/drafting card fields

**Files:**
- Modify: `src/components/diffpress/Dashboard.tsx`

- [ ] **Step 1: Update `DiscoveryArticle`**

In `src/components/diffpress/Dashboard.tsx`, replace the `DiscoveryArticle` function (lines 56-67) with:

```tsx
function DiscoveryArticle({ card }: { card: DiscoveryCard }) {
  return (
    <article className={CARD_BASE}>
      <RepoName>{card.repo}</RepoName>
      <Desc>{card.desc}</Desc>
      <div className={cn("flex gap-4", META)}>
        <span>★ {card.stars.toLocaleString()}</span>
        {card.language ? <span>{card.language}</span> : null}
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Update `DraftingArticle`**

Replace the `DraftingArticle` function (lines 95-122) with:

```tsx
function DraftingArticle({ card }: { card: DraftingCard }) {
  return (
    <article className={CARD_BASE}>
      <RepoName>{card.repo}</RepoName>
      <Desc>{card.desc}</Desc>
      <div className="flex items-center gap-[10px]">
        <span className="flex gap-1">
          {[0, 0.2, 0.4].map((d) => (
            <span
              key={d}
              className="dp-pulse h-[5px] w-[5px] rounded-full bg-dp-slate"
              style={{ animationDelay: `${d}s` }}
            />
          ))}
        </span>
        <span className="font-dp-mono text-[11.5px] text-[#8a877f]">drafting…</span>
      </div>
    </article>
  );
}
```

- [ ] **Step 3: Verify typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — confirms the Task 9 types now line up with all consumers.

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/Dashboard.tsx
git commit -m "feat(diffpress): render real stars/language and drafting state on cards"
```

---

## Task 13: Remove the dead pipeline mock from data.ts

**Files:**
- Modify: `src/components/diffpress/data.ts`

- [ ] **Step 1: Delete the dead exports**

In `src/components/diffpress/data.ts`, delete:
- the `PIPELINE` export (the entire `export const PIPELINE: PipelineData = { ... };` block),
- the `HANDOFFS` export (`export const HANDOFFS: Record<string, HandoffDoc> = { ... };`),
- the `REVIEW_BLOCKS` export (`export const REVIEW_BLOCKS: ... = [ ... ];`).

Keep `ARTICLE_HTML`, `TECH_EDITOR_NOTES`, and `EMPTY_DEPLOY`.

- [ ] **Step 2: Remove now-unused type imports**

At the top of `data.ts`, the import block:

```ts
import type {
  DeployPayload,
  HandoffDoc,
  PipelineData,
  TechEditorNote,
} from "./types";
```

becomes (drop `HandoffDoc` and `PipelineData`, which were only used by the deleted exports):

```ts
import type { DeployPayload, TechEditorNote } from "./types";
```

- [ ] **Step 3: Verify typecheck catches no stragglers**

Run: `npx tsc --noEmit`
Expected: PASS. (If any file still imports `PIPELINE`/`HANDOFFS`/`REVIEW_BLOCKS`, tsc will flag it — there should be none after Tasks 10–11.)

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/data.ts
git commit -m "chore(diffpress): remove dead pipeline-board mock data"
```

---

## Task 14: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all suites green.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Production build**

Run: `npm run build`
Expected: Builds without error.

- [ ] **Step 4: Commit any incidental fixes** (only if Steps 1-3 required changes)

```bash
git add -A
git commit -m "fix(diffpress): resolve verification findings"
```

---

## Task 15: Deploy and clear stale ledger data (manual, confirmed)

**Files:** none (deploy + data operation)

This task runs against live AWS and is intentionally manual — confirm each step.

- [ ] **Step 1: Deploy**

Run: `npm run deploy:prod`
Expected: Deploys; CloudFormation/Pulumi adds the `status-index` GSI and TTL to `PublicationLifecycle` and updates `DiffPressDraftArticle`. GSI backfill on an existing table is online.

- [ ] **Step 2: Identify stale rows**

Find the deployed table name, then list current items:

```bash
aws dynamodb scan \
  --table-name "$(npx sst shell --stage production -- node -e 'console.log(require("sst").Resource.PublicationLifecycle.name)')" \
  --projection-expression "repoName, #s" \
  --expression-attribute-names '{"#s":"status"}'
```

Confirm the stub-era row `pewdiepie-archdaemon/odysseus` (and any other obvious test rows) appear.

- [ ] **Step 2 (alternative): get the table name from the AWS console**

If the `sst shell` one-liner is awkward, copy the `PublicationLifecycle` table name from the SST deploy output or the DynamoDB console and use it directly below.

- [ ] **Step 3: Delete the stale row(s)**

For each stale `repoName` (replace `<TABLE>` and the repo name):

```bash
aws dynamodb delete-item \
  --table-name "<TABLE>" \
  --key '{"repoName": {"S": "pewdiepie-archdaemon/odysseus"}}'
```

- [ ] **Step 4: Manual E2E verification**

- Trigger discovery (the `ContentEngineTrigger` function URL or wait for the cron).
- Open `/diffpress`: confirm the **Discovery** column shows real GitHub repos with star counts + language (not helix/loom/agentmesh).
- Select one through the handoff drawer, submit a developer log to resume.
- Confirm the card moves **Ready-for-Dev → Drafting → In-Review**, and the In-Review card carries a genuine Gemini-generated headline (not "A Critical Read of…").

- [ ] **Step 5: Finish the branch**

Use the `superpowers:finishing-a-development-branch` skill to merge `diffpress-real-discovery` to `main`.

---

## Notes for the executor

- **TDD order matters:** pure helpers (`dedupeByExisting`, `toDiscoveredRecord`, `buildMark*Params`, `bucketBoard`) are tested directly; AWS-wrapping helpers (`batchGetExisting`, `queryByStatus`, etc.) and handlers that call them are verified via `tsc` + the manual E2E, not unit-mocked — matching the existing repo convention (handlers in this codebase aren't unit-tested with AWS mocks).
- **`language` is a DynamoDB reserved word** — always alias it (`#lang`) in expressions (handled in `queryByStatus`).
- **GSI backfill:** adding `status-index` to a populated table backfills asynchronously; the board may briefly under-report immediately after deploy. This resolves on its own.
