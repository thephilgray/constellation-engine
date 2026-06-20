# DiffPress Board Actions (Dismiss + Regenerate Handoff) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users dismiss board cards (Discovery and Ready-for-Dev) and regenerate a Ready-for-Dev handoff brief in place.

**Architecture:** A new `DISMISSED` ledger status (bucketBoard already drops unknown statuses; batchGetExisting already excludes any ledgered repo, so dismissed repos vanish and never resurface). One new authenticated route `POST /api/board-action` with a single Lambda that switches on `action`: `dismiss` (release the paused Step Functions execution via `SendTaskFailure` when the card is Ready-for-Dev, then flip to `DISMISSED`) and `regenerate-handoff` (rebuild minimal pipeline state from the ledger row, reuse `generateHandoff`'s pure functions, write a fresh brief back). Frontend adds a hover ✕ on Discovery cards and Regenerate/Dismiss buttons in the handoff drawer.

**Tech Stack:** TypeScript, SST v3 (AWS Lambda + API Gateway + DynamoDB + Step Functions + S3), `@aws-sdk/client-sfn`, `@aws-sdk/lib-dynamodb`, `@google/genai` (Gemini), React + Zustand, Vitest.

## Global Constraints

- The handoff brief is human-facing only; `draftArticle` consumes `repoUrl` + `developerLog`, never `handoffPrompt`. Regenerating it must not touch the paused execution or its task token.
- Ready-for-Dev cards hold a live Step Functions task token. Any action that removes such a card MUST call `SendTaskFailure(taskToken)` first, or the execution hangs until timeout.
- `regenerate-handoff` is valid ONLY for `AWAITING_HANDOFF` rows. `dismiss` is valid for `DISCOVERED` and `AWAITING_HANDOFF` rows; reject `DRAFTING`/`PUBLISHED`.
- Follow existing patterns: pure builder functions for Dynamo params (`buildMark*Params`), `parse*Event` for request validation, one route per `api.route(...)` call with the JWT authorizer block.
- Tests use Vitest. When mocking, `beforeEach` must use a block body (`beforeEach(() => { ... })`), never an expression-arrow returning a mock (causes a false-positive unhandled-rejection failure).

---

### Task 1: Ledger — `DISMISSED` status and two new mutations

**Files:**
- Modify: `src/diffpress/types.ts:90-94` (add `"DISMISSED"` to `PublicationStatus`)
- Modify: `src/diffpress/lib/ledger.ts` (add two pure param builders + two async wrappers)
- Test: `src/diffpress/lib/ledger.test.ts` (create)

**Interfaces:**
- Produces:
  - `buildMarkDismissedParams(table: string, repoName: string): UpdateCommandInput`
  - `markDismissed(repoName: string): Promise<void>`
  - `buildSetHandoffPromptParams(table: string, repoName: string, meta: { handoffPrompt: string; mode?: "narrative" | "explainer" }): UpdateCommandInput`
  - `setHandoffPrompt(repoName: string, meta: { handoffPrompt: string; mode?: "narrative" | "explainer" }): Promise<void>`

- [ ] **Step 1: Add `DISMISSED` to the status union**

In `src/diffpress/types.ts`, change `PublicationStatus`:

```typescript
export type PublicationStatus =
  | "DISCOVERED"
  | "AWAITING_HANDOFF"
  | "DRAFTING"
  | "PUBLISHED"
  | "DISMISSED";
```

- [ ] **Step 2: Write the failing test for the param builders**

Create `src/diffpress/lib/ledger.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildMarkDismissedParams,
  buildSetHandoffPromptParams,
} from "./ledger";

describe("buildMarkDismissedParams", () => {
  it("flips status to DISMISSED, guarding against PUBLISHED", () => {
    const params = buildMarkDismissedParams("tbl", "owner/repo");
    expect(params.TableName).toBe("tbl");
    expect(params.Key).toEqual({ repoName: "owner/repo" });
    expect(params.UpdateExpression).toBe("SET #status = :dismissed");
    expect(params.ConditionExpression).toBe(
      "attribute_not_exists(#status) OR #status <> :published",
    );
    expect(params.ExpressionAttributeValues).toMatchObject({
      ":dismissed": "DISMISSED",
      ":published": "PUBLISHED",
    });
  });
});

describe("buildSetHandoffPromptParams", () => {
  it("sets handoffPrompt + mode only on an AWAITING_HANDOFF row", () => {
    const params = buildSetHandoffPromptParams("tbl", "owner/repo", {
      handoffPrompt: "# new brief",
      mode: "narrative",
    });
    expect(params.UpdateExpression).toBe(
      "SET handoffPrompt = :handoffPrompt, #mode = :mode",
    );
    expect(params.ConditionExpression).toBe("#status = :awaiting");
    expect(params.ExpressionAttributeNames).toMatchObject({
      "#status": "status",
      "#mode": "mode",
    });
    expect(params.ExpressionAttributeValues).toMatchObject({
      ":handoffPrompt": "# new brief",
      ":mode": "narrative",
      ":awaiting": "AWAITING_HANDOFF",
    });
  });

  it("stores null mode when omitted", () => {
    const params = buildSetHandoffPromptParams("tbl", "owner/repo", {
      handoffPrompt: "# brief",
    });
    expect(params.ExpressionAttributeValues?.[":mode"]).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: FAIL — `buildMarkDismissedParams`/`buildSetHandoffPromptParams` are not exported.

- [ ] **Step 4: Implement the param builders and wrappers**

In `src/diffpress/lib/ledger.ts`, add after `buildMarkAwaitingParams` (around line 84):

```typescript
/** Pure: flip an item to DISMISSED (only if not already PUBLISHED). */
export function buildMarkDismissedParams(
  table: string,
  repoName: string
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression: "SET #status = :dismissed",
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":dismissed": "DISMISSED", ":published": "PUBLISHED" },
  };
}

/** Pure: overwrite the handoff brief in place, only while still AWAITING_HANDOFF. */
export function buildSetHandoffPromptParams(
  table: string,
  repoName: string,
  meta: { handoffPrompt: string; mode?: "narrative" | "explainer" }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression: "SET handoffPrompt = :handoffPrompt, #mode = :mode",
    ConditionExpression: "#status = :awaiting",
    // `mode` and `status` are DynamoDB reserved words.
    ExpressionAttributeNames: { "#status": "status", "#mode": "mode" },
    ExpressionAttributeValues: {
      ":handoffPrompt": meta.handoffPrompt,
      ":mode": meta.mode ?? null,
      ":awaiting": "AWAITING_HANDOFF",
    },
  };
}
```

Then add the async wrappers near `markDrafting` (around line 143):

```typescript
/** Flip an item to DISMISSED. Swallows the conditional-check failure (idempotent). */
export async function markDismissed(repoName: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand(buildMarkDismissedParams(tableName(), repoName))
    );
  } catch (err) {
    if (isAlreadyPublishedError(err)) {
      console.log(`[ledger] ${repoName} already published; skip DISMISSED.`);
      return;
    }
    throw err;
  }
}

/** Overwrite the handoff brief for an AWAITING_HANDOFF item. */
export async function setHandoffPrompt(
  repoName: string,
  meta: { handoffPrompt: string; mode?: "narrative" | "explainer" }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildSetHandoffPromptParams(tableName(), repoName, meta))
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/types.ts src/diffpress/lib/ledger.ts src/diffpress/lib/ledger.test.ts
git commit -m "feat(diffpress): add DISMISSED status and handoff-prompt ledger mutations"
```

---

### Task 2: `board-action` Lambda + route

**Files:**
- Modify: `src/diffpress/generateHandoff.ts:117` (export the `generateBrief` helper for reuse)
- Create: `src/diffpress/boardAction.ts`
- Test: `src/diffpress/boardAction.test.ts`
- Modify: `sst.config.ts` (register `POST /api/board-action` after the `GET /api/handoffs` route, ~line 415)

**Interfaces:**
- Consumes (from Task 1): `markDismissed`, `setHandoffPrompt`. From `generateHandoff.ts`: `buildMetaPrompt`, `generateBrief`, `resolveHandoff`. From `lib/ledger.ts`: `getByRepo` (the single-record reader, signature `getByRepo(repoName): Promise<PublicationRecord | null>`). From `lib/payloadStore.ts`: `getPayload`.
- Produces:
  - `parseBoardActionEvent(event: APIGatewayProxyEventV2): ParseResult` where the success value is `{ repoName: string; action: "dismiss" | "regenerate-handoff" }`
  - `reconstructCandidate(record: PublicationRecord): RepoCandidate`
  - `handler(event): Promise<APIGatewayProxyResultV2>`

- [ ] **Step 1: Export `generateBrief` from generateHandoff.ts**

In `src/diffpress/generateHandoff.ts`, change the helper at line 117 from `async function generateBrief(` to:

```typescript
export async function generateBrief(prompt: string): Promise<string> {
```

(No other change — it already exists; only add `export`.)

- [ ] **Step 2: Write the failing test for parsing and candidate reconstruction**

Create `src/diffpress/boardAction.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { parseBoardActionEvent, reconstructCandidate } from "./boardAction";
import type { PublicationRecord } from "./types";

function event(body: unknown, authed = true): APIGatewayProxyEventV2 {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: authed
      ? ({ authorizer: { jwt: { claims: { sub: "user-1" } } } } as any)
      : ({} as any),
  } as APIGatewayProxyEventV2;
}

describe("parseBoardActionEvent", () => {
  it("rejects unauthenticated requests", () => {
    const r = parseBoardActionEvent(event({ repoName: "a/b", action: "dismiss" }, false));
    expect(r).toMatchObject({ ok: false, statusCode: 401 });
  });

  it("rejects an unknown action", () => {
    const r = parseBoardActionEvent(event({ repoName: "a/b", action: "delete" }));
    expect(r).toMatchObject({ ok: false, statusCode: 400 });
  });

  it("accepts a valid dismiss request", () => {
    const r = parseBoardActionEvent(event({ repoName: "a/b", action: "dismiss" }));
    expect(r).toEqual({ ok: true, value: { repoName: "a/b", action: "dismiss" } });
  });
});

describe("reconstructCandidate", () => {
  it("maps a ledger row to a RepoCandidate with safe fallbacks", () => {
    const rec: PublicationRecord = {
      repoName: "a/b",
      status: "AWAITING_HANDOFF",
      repoUrl: "https://github.com/a/b",
      description: "desc",
      stars: 42,
      language: "Rust",
      signalType: "TRENDING",
    };
    const c = reconstructCandidate(rec);
    expect(c).toMatchObject({
      repoName: "a/b",
      repoUrl: "https://github.com/a/b",
      description: "desc",
      stars: 42,
      language: "Rust",
    });
  });

  it("defaults missing optional fields", () => {
    const c = reconstructCandidate({ repoName: "a/b", status: "AWAITING_HANDOFF" });
    expect(c.repoUrl).toBe("");
    expect(c.description).toBe("");
    expect(c.stars).toBe(0);
    expect(c.language).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/boardAction.test.ts`
Expected: FAIL — `./boardAction` does not exist.

- [ ] **Step 4: Implement the Lambda**

Create `src/diffpress/boardAction.ts`:

```typescript
// src/diffpress/boardAction.ts
import { SFNClient, SendTaskFailureCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getByRepo, markDismissed, setHandoffPrompt } from "./lib/ledger";
import { getPayload } from "./lib/payloadStore";
import { buildMetaPrompt, generateBrief, resolveHandoff } from "./generateHandoff";
import type { PublicationRecord, RepoCandidate } from "./types";

const sfn = new SFNClient({});

export type BoardAction = "dismiss" | "regenerate-handoff";

export interface ParsedBoardAction {
  repoName: string;
  action: BoardAction;
}

export type ParseResult =
  | { ok: true; value: ParsedBoardAction }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + body. No AWS calls. */
export function parseBoardActionEvent(event: APIGatewayProxyEventV2): ParseResult {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) return { ok: false, statusCode: 401, message: "Unauthorized" };
  if (!event.body) return { ok: false, statusCode: 400, message: "Missing request body" };
  let parsed: any;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body" };
  }
  const { repoName, action } = parsed ?? {};
  if (typeof repoName !== "string" || !repoName) {
    return { ok: false, statusCode: 400, message: "repoName is required" };
  }
  if (action !== "dismiss" && action !== "regenerate-handoff") {
    return { ok: false, statusCode: 400, message: "action must be 'dismiss' or 'regenerate-handoff'" };
  }
  return { ok: true, value: { repoName, action } };
}

/** Pure: rebuild a RepoCandidate from a ledger row for handoff regeneration. */
export function reconstructCandidate(record: PublicationRecord): RepoCandidate {
  return {
    repoName: record.repoName,
    repoUrl: record.repoUrl ?? "",
    description: record.description ?? "",
    stars: record.stars ?? 0,
    language: record.language ?? null,
    pushedAt: record.pushedAt ?? "",
    signalType: record.signalType,
    starsGained: record.starsGained,
    releaseTag: record.releaseTag,
    coverageScore: record.coverageScore,
    coverageSources: record.coverageSources,
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, body: JSON.stringify(body) };
}

async function doDismiss(record: PublicationRecord): Promise<APIGatewayProxyResultV2> {
  if (record.status !== "DISCOVERED" && record.status !== "AWAITING_HANDOFF") {
    return json(400, { message: `Cannot dismiss a ${record.status} card.` });
  }
  // Ready-for-Dev: release the paused execution before flipping the row,
  // otherwise the Step Functions execution hangs until task-token timeout.
  if (record.status === "AWAITING_HANDOFF" && record.taskToken) {
    try {
      await sfn.send(
        new SendTaskFailureCommand({
          taskToken: record.taskToken,
          error: "DismissedByUser",
          cause: "Card dismissed from the DiffPress board.",
        })
      );
    } catch (err: any) {
      // Token already gone (resumed/expired) is fine — proceed to dismiss the row.
      if (err?.name !== "TaskDoesNotExist" && err?.name !== "InvalidToken") throw err;
    }
  }
  await markDismissed(record.repoName);
  return json(200, { message: "Card dismissed.", repoName: record.repoName });
}

async function doRegenerate(record: PublicationRecord): Promise<APIGatewayProxyResultV2> {
  if (record.status !== "AWAITING_HANDOFF") {
    return json(400, { message: "Only Ready-for-Dev cards can regenerate a handoff." });
  }
  if (!record.payloadKey) {
    return json(409, { message: "No enrichment payload on record; cannot regenerate." });
  }
  // Seed ideas are not persisted; regeneration omits them (brief falls back to
  // "invent an original idea"). Acceptable degradation. ponytail: re-thread seeds
  // through the ledger if briefs noticeably suffer.
  const payload = await getPayload(record.payloadKey);
  const prompt = buildMetaPrompt({
    repo: reconstructCandidate(record),
    documentation: payload.documentation,
    seedIdeas: [],
  });
  const raw = await generateBrief(prompt);
  const { mode, handoffPrompt } = resolveHandoff(raw, record.repoName);
  await setHandoffPrompt(record.repoName, { handoffPrompt, mode });
  return json(200, { message: "Handoff regenerated.", handoffPrompt });
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseBoardActionEvent(event);
  if (!parsed.ok) return json(parsed.statusCode, { message: parsed.message });

  const { repoName, action } = parsed.value;
  try {
    const record = await getByRepo(repoName);
    if (!record) return json(404, { message: `No card for ${repoName}.` });
    return action === "dismiss" ? doDismiss(record) : doRegenerate(record);
  } catch (error) {
    console.error(`[boardAction] ${action} failed for ${repoName}:`, error);
    return json(500, { message: "Board action failed." });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/boardAction.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Register the route**

In `sst.config.ts`, add immediately after the `GET /api/handoffs` route block (after line 415):

```typescript
    // Board card actions: dismiss (releases the paused execution for
    // Ready-for-Dev cards) and regenerate-handoff (re-rolls the brief in place).
    api.route("POST /api/board-action", {
      handler: "src/diffpress/boardAction.handler",
      link: [auth, publicationLifecycle, GEMINI_API_KEY, contentPayloadBucket],
      permissions: [
        { actions: ["states:SendTaskFailure"], resources: ["*"] },
      ],
      timeout: "60 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). If `sst-env.d.ts` is stale for the new route, that is expected until `sst dev`/`sst deploy` regenerates types; the route handler itself must typecheck.

- [ ] **Step 8: Commit**

```bash
git add src/diffpress/generateHandoff.ts src/diffpress/boardAction.ts src/diffpress/boardAction.test.ts sst.config.ts
git commit -m "feat(diffpress): add board-action Lambda for dismiss + regenerate-handoff"
```

---

### Task 3: Frontend services + store actions

**Files:**
- Modify: `src/components/diffpress/services.ts` (add two POST calls)
- Modify: `src/components/diffpress/store.ts` (add a pure removal helper + two actions + interface entries)
- Test: `src/components/diffpress/store.test.ts` (create — tests the pure helper only)

**Interfaces:**
- Consumes (backend): `POST /api/board-action` with body `{ repoName, action }`. Regenerate response: `{ handoffPrompt: string }`.
- Produces:
  - services: `dismissCard(repoName: string): Promise<void>`, `regenerateHandoff(repoName: string): Promise<{ handoffPrompt: string }>`
  - store: `dismissCard(repoName: string): Promise<void>`, `regenerateHandoff(): Promise<void>` (acts on the open drawer)
  - helper: `removeFromPipeline(pipeline: PipelineData, repoName: string): PipelineData`

- [ ] **Step 1: Add the service calls**

In `src/components/diffpress/services.ts`, add after `publishHandoff` (around line 85):

```typescript
/** Dismiss a board card (Discovery or Ready-for-Dev) via `POST /api/board-action`. */
export async function dismissCard(repoName: string): Promise<void> {
  const res = await authedFetch("/api/board-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoName, action: "dismiss" }),
  });
  if (!res.ok) throw new Error(`Failed to dismiss card (${res.status})`);
}

/** Re-roll a Ready-for-Dev handoff brief via `POST /api/board-action`. */
export async function regenerateHandoff(
  repoName: string,
): Promise<{ handoffPrompt: string }> {
  const res = await authedFetch("/api/board-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoName, action: "regenerate-handoff" }),
  });
  if (!res.ok) throw new Error(`Failed to regenerate handoff (${res.status})`);
  return res.json();
}
```

- [ ] **Step 2: Write the failing test for the pure removal helper**

Create `src/components/diffpress/store.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { removeFromPipeline } from "./store";
import type { PipelineData } from "./types";

const base: PipelineData = {
  discovery: [
    { id: "a/b", repo: "a/b", desc: "", stars: 0, language: "", lastUpdated: "" },
    { id: "c/d", repo: "c/d", desc: "", stars: 0, language: "", lastUpdated: "" },
  ],
  readyForDev: [{ id: "e/f", repo: "e/f", desc: "" }],
  drafting: [],
  inReview: [],
};

describe("removeFromPipeline", () => {
  it("removes a card from whichever column holds it", () => {
    const next = removeFromPipeline(base, "a/b");
    expect(next.discovery.map((c) => c.id)).toEqual(["c/d"]);
    expect(next.readyForDev).toHaveLength(1);
  });

  it("removes from readyForDev too", () => {
    const next = removeFromPipeline(base, "e/f");
    expect(next.readyForDev).toHaveLength(0);
    expect(next.discovery).toHaveLength(2);
  });

  it("is a no-op for an unknown id", () => {
    const next = removeFromPipeline(base, "x/y");
    expect(next.discovery).toHaveLength(2);
    expect(next.readyForDev).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/diffpress/store.test.ts`
Expected: FAIL — `removeFromPipeline` is not exported.

- [ ] **Step 4: Implement the helper + store actions**

In `src/components/diffpress/store.ts`, add the imports `dismissCard as dismissCardApi, regenerateHandoff as regenerateHandoffApi` to the existing `./services` import block.

Add the pure helper near the other module-level helpers (after `persistConfigDebounced`, ~line 56):

```typescript
/** Pure: drop a card by id from every board column. */
export function removeFromPipeline(
  pipeline: PipelineData,
  repoName: string,
): PipelineData {
  return {
    discovery: pipeline.discovery.filter((c) => c.id !== repoName),
    readyForDev: pipeline.readyForDev.filter((c) => c.id !== repoName),
    drafting: pipeline.drafting.filter((c) => c.id !== repoName),
    inReview: pipeline.inReview.filter((c) => c.id !== repoName),
  };
}
```

Add to the `DiffPressState` interface, in the `// ---- pipeline board ----` section (after `loadPipeline`):

```typescript
  dismissCard: (repoName: string) => Promise<void>;
```

Add to the `// ---- handoff drawer ----` section (after `submitResume`):

```typescript
  regenerating: boolean;
  regenerateHandoff: () => Promise<void>;
```

In the store body, add the `dismissCard` action after `loadPipeline` (~line 158):

```typescript
  dismissCard: async (repoName) => {
    // Optimistic: remove immediately, then persist. On failure, reload to resync.
    const prev = get().pipeline;
    set({ pipeline: removeFromPipeline(prev, repoName), drawerId: null });
    try {
      await dismissCardApi(repoName);
    } catch (err) {
      console.warn("[diffpress] dismiss failed; reloading board:", err);
      await get().loadPipeline();
    }
  },
```

Add `regenerating: false,` to the drawer state initializers (near `resuming: false,` ~line 228), and add the `regenerateHandoff` action after `submitResume` (~line 291):

```typescript
  regenerateHandoff: async () => {
    const { drawerId, handoffDoc } = get();
    if (!drawerId || !handoffDoc) return;
    set({ regenerating: true });
    try {
      const { handoffPrompt } = await regenerateHandoffApi(drawerId);
      // Update the open drawer and the cached card so a reopen shows the new brief.
      set((s) => ({
        regenerating: false,
        handoffDoc: s.handoffDoc ? { ...s.handoffDoc, handoff: handoffPrompt } : null,
        pipeline: {
          ...s.pipeline,
          readyForDev: s.pipeline.readyForDev.map((c) =>
            c.id === drawerId ? { ...c, handoffPrompt } : c,
          ),
        },
      }));
    } catch (err) {
      console.error("[diffpress] regenerate failed:", err);
      set({ regenerating: false });
    }
  },
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/diffpress/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/diffpress/services.ts src/components/diffpress/store.ts src/components/diffpress/store.test.ts
git commit -m "feat(diffpress): store + service actions for dismiss and regenerate"
```

---

### Task 4: Frontend UI — Discovery ✕ and drawer buttons

**Files:**
- Modify: `src/components/diffpress/Dashboard.tsx` (`DiscoveryArticle` — hover ✕)
- Modify: `src/components/diffpress/HandoffDrawer.tsx` (Regenerate + Dismiss buttons)

**Interfaces:**
- Consumes (from Task 3): store `dismissCard(repoName)`, `regenerateHandoff()`, `regenerating`.

- [ ] **Step 1: Add the dismiss ✕ to Discovery cards**

In `src/components/diffpress/Dashboard.tsx`, update `DiscoveryArticle` (line 87). Add the `X` icon to the existing `lucide-react` import at line 1 (`import { ChevronRight, ListFilter, SquarePen, X } from "lucide-react";`). Then wrap the card so a hover-revealed ✕ sits in the corner:

```tsx
function DiscoveryArticle({ card }: { card: DiscoveryCard }) {
  const badge = reasonBadge(card);
  const coverage = coverageTier(card.coverageScore);
  const dismissCard = useDiffPress((s) => s.dismissCard);
  return (
    <article className={cn(CARD_BASE, "group relative")}>
      <button
        onClick={() => dismissCard(card.id)}
        aria-label={`Dismiss ${card.repo}`}
        className="absolute right-[10px] top-[10px] hidden cursor-pointer border-none bg-transparent p-1 text-dp-faint-3 hover:text-dp-ink group-hover:block"
      >
        <X size={14} strokeWidth={1.7} />
      </button>
      <RepoName>
        {card.repoUrl ? (
          <a
            href={card.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="hover:underline"
          >
            {card.repo}
          </a>
        ) : (
          card.repo
        )}
      </RepoName>
      <Desc>{card.desc}</Desc>
      <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1", META)}>
        {badge ? <span className="font-medium text-dp-slate">{badge}</span> : null}
        <span><span aria-hidden="true">★</span> {card.stars.toLocaleString()}</span>
        {card.language ? <span>{card.language}</span> : null}
        {coverage ? <span className="text-dp-slate">{coverage}</span> : null}
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Add Regenerate + Dismiss to the handoff drawer**

In `src/components/diffpress/HandoffDrawer.tsx`: add `RefreshCw` to the `lucide-react` import (`import { Copy, RefreshCw, X } from "lucide-react";`). Pull the new store bindings in alongside the others (after line 17):

```tsx
  const regenerating = useDiffPress((s) => s.regenerating);
  const regenerateHandoff = useDiffPress((s) => s.regenerateHandoff);
  const dismissCard = useDiffPress((s) => s.dismissCard);
  const drawerId = useDiffPress((s) => s.drawerId);
```

(`drawerId` is already selected at line 6 — do not duplicate it; reuse the existing one.)

Replace the "Handoff Prompt / Copy" header row (lines 57-68) so it also offers Regenerate:

```tsx
        <div className="mb-[10px] flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-dp-muted">
            Handoff Prompt
          </span>
          <div className="flex items-center gap-4">
            <button
              onClick={regenerateHandoff}
              disabled={regenerating}
              className="flex cursor-pointer items-center gap-[6px] border-none bg-transparent p-0 text-[12px] font-medium text-dp-slate hover:opacity-70 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={13} strokeWidth={1.7} className={regenerating ? "dp-pulse" : ""} />
              {regenerating ? "Regenerating…" : "Regenerate"}
            </button>
            <button
              onClick={copyHandoff}
              className="flex cursor-pointer items-center gap-[6px] border-none bg-transparent p-0 text-[12px] font-medium text-dp-slate hover:opacity-70"
            >
              <Copy size={13} strokeWidth={1.7} />
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
```

Then add a Dismiss action at the bottom of the drawer body. Insert just before the closing `</aside>` (after line 126's closing `)}` of the resumed/resume block, before `</aside>`):

```tsx
        <button
          onClick={() => dismissCard(drawerId)}
          className="mt-8 cursor-pointer border-none bg-transparent p-0 text-[12.5px] font-medium text-dp-faint hover:text-dp-ink"
        >
          Dismiss this card
        </button>
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Build the frontend to confirm it compiles**

Run: `npx astro build` (or the project's build script: `npm run build`)
Expected: build succeeds.

- [ ] **Step 5: Manual verification**

Run the app (`npm run dev` / `sst dev` per project convention) and confirm:
- A Discovery card shows a ✕ on hover; clicking it removes the card.
- Opening a Ready-for-Dev card shows Regenerate + Copy in the prompt header and a "Dismiss this card" link at the bottom.
- Clicking Regenerate replaces the brief text (spinner while in flight).
- Clicking Dismiss closes the drawer and removes the card.

- [ ] **Step 6: Commit**

```bash
git add src/components/diffpress/Dashboard.tsx src/components/diffpress/HandoffDrawer.tsx
git commit -m "feat(diffpress): board UI for dismiss (Discovery ✕) and drawer regenerate/dismiss"
```

---

## Post-implementation verification

- [ ] **Full test run:** `npx vitest run` — all tests pass.
- [ ] **Typecheck:** `npx tsc --noEmit` — clean.
- [ ] **Open dependency check (from spec):** During `sst dev`/deploy, confirm `getPayload(payloadKey)` succeeds for a card that has been in Ready-for-Dev for a while (the S3 enrichment payload is not lifecycle-expired). If it 404s, `regenerate-handoff` returns 409 today; the follow-up is to persist `documentation` on the ledger row instead of reading S3.
- [ ] **Execution release check:** After dismissing a Ready-for-Dev card, confirm in the AWS console (or `aws stepfunctions list-executions`) that the corresponding ContentEngine execution left `RUNNING`.
```
