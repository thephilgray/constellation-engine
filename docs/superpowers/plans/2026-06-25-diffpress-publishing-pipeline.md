# DiffPress Publishing Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `deployArticle` mock with a real publishing pipeline that posts a finished article to Dev.to and to per-domain signed webhooks, with publish-now and scheduled-publish support.

**Architecture:** A standalone authenticated `POST /api/publish` Lambda loads the article from the PublicationLifecycle ledger by `repoName` and fans out to enabled targets, returning per-target results. Scheduling writes a `SCHEDULED` ledger record that a 5-minute cron Lambda publishes when due. Pure helpers (slug, HMAC signature, payload/body builders, summary, input parsing) live in `lib/publish.ts` and carry the unit tests; the handler and cron are thin glue around them.

**Tech Stack:** SST v3 (AWS Lambda, DynamoDB, Cron, Secret), TypeScript, Node 20 `crypto` (HMAC) and global `fetch`, Vitest, React + Zustand frontend.

## Global Constraints

- Real targets in v1: **Dev.to** (API) and **webhook domains** `diffpress` + `thephilgray`. `linkedin`/`substack` remain stubs returning `{ ok: false, detail: "not supported" }`.
- Secrets only — no DB-backed config UI. `DEVTO_API_KEY` (string) and `PUBLISH_WEBHOOKS` (JSON `{ diffpress: { url, secret }, thephilgray: { url, secret } }`).
- Webhook signature header: `X-DiffPress-Signature: sha256=<hex HMAC-SHA256(rawBody, secret)>`.
- Canonical URL = the own-domain being published to; default `https://diffpress.com` when ambiguous. Form: `${base}/${slug}`.
- `seriesLink` is a URL — it goes in the webhook payload only. Do **not** map it to Dev.to's `series` (that field is a series *name*, not a URL).
- Partial failure is allowed: a failing target is reported `ok: false` and never blocks other targets. Ledger flips to `PUBLISHED` if **any** target succeeded.
- Follow existing handler patterns: pure `parse*` function for auth/body validation, `getByRepo` for ledger reads, `Resource.<NAME>.value` for secrets.
- Frontend calls go through `authedFetch` (see `src/components/diffpress/services.ts`).

---

### Task 1: Pure publish helpers (`lib/publish.ts`)

**Files:**
- Create: `src/diffpress/lib/publish.ts`
- Test: `src/diffpress/lib/publish.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type TargetId = "devto" | "diffpress" | "thephilgray" | "linkedin" | "substack"`
  - `interface PublishTargets { devto: boolean; diffpress: boolean; thephilgray: boolean; linkedin: boolean; substack: boolean }`
  - `interface PublishInput { repoName: string; targets: PublishTargets; timing: "now" | "schedule"; scheduleAt: string; seriesLink: string }`
  - `interface TargetResult { id: TargetId; ok: boolean; detail: string }`
  - `interface WebhookPayload { title: string; slug: string; markdown: string; canonicalUrl: string; publishedAt: string; series: string | null; repoName: string }`
  - `function slugify(title: string): string`
  - `function signWebhook(rawBody: string, secret: string): string` → `"sha256=<hex>"`
  - `function canonicalUrlFor(targets: PublishTargets, slug: string): string`
  - `function buildWebhookPayload(args: { title: string; markdown: string; repoName: string; seriesLink: string; targets: PublishTargets; publishedAt: string }): WebhookPayload`
  - `function buildDevtoArticle(args: { title: string; markdown: string; canonicalUrl: string }): { article: { title: string; body_markdown: string; published: true; canonical_url: string } }`
  - `function selectedTargets(targets: PublishTargets): TargetId[]`
  - `function summarizeResults(results: TargetResult[]): string`
  - `function parsePublishInput(event: { requestContext?: any; body?: string | null }): { ok: true; value: PublishInput } | { ok: false; statusCode: number; message: string }`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/diffpress/lib/publish.test.ts
import { describe, it, expect } from "vitest";
import {
  slugify,
  signWebhook,
  canonicalUrlFor,
  buildWebhookPayload,
  buildDevtoArticle,
  selectedTargets,
  summarizeResults,
  parsePublishInput,
  type PublishTargets,
} from "./publish";

const allOff: PublishTargets = {
  devto: false, diffpress: false, thephilgray: false, linkedin: false, substack: false,
};

describe("slugify", () => {
  it("lowercases, hyphenates, strips punctuation", () => {
    expect(slugify("State of the Art: Helix!")).toBe("state-of-the-art-helix");
  });
  it("collapses repeated separators and trims", () => {
    expect(slugify("  Hello   World  ")).toBe("hello-world");
  });
});

describe("signWebhook", () => {
  it("produces a stable sha256= HMAC for a body+secret", () => {
    const sig = signWebhook('{"a":1}', "topsecret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Deterministic: same inputs -> same signature.
    expect(signWebhook('{"a":1}', "topsecret")).toBe(sig);
    // Different secret -> different signature.
    expect(signWebhook('{"a":1}', "other")).not.toBe(sig);
  });
});

describe("canonicalUrlFor", () => {
  it("uses the single own-domain target", () => {
    expect(canonicalUrlFor({ ...allOff, thephilgray: true }, "my-post"))
      .toBe("https://thephilgray.com/my-post");
  });
  it("defaults to diffpress.com when multiple own-domains or none", () => {
    expect(canonicalUrlFor({ ...allOff, diffpress: true, thephilgray: true }, "my-post"))
      .toBe("https://diffpress.com/my-post");
    expect(canonicalUrlFor({ ...allOff, devto: true }, "my-post"))
      .toBe("https://diffpress.com/my-post");
  });
});

describe("buildDevtoArticle", () => {
  it("wraps the markdown with published:true and the canonical url", () => {
    const body = buildDevtoArticle({ title: "T", markdown: "# B", canonicalUrl: "https://diffpress.com/t" });
    expect(body).toEqual({
      article: { title: "T", body_markdown: "# B", published: true, canonical_url: "https://diffpress.com/t" },
    });
  });
});

describe("buildWebhookPayload", () => {
  it("derives slug + canonical and carries seriesLink as series", () => {
    const p = buildWebhookPayload({
      title: "My Post", markdown: "body", repoName: "o/r",
      seriesLink: "https://x/prev", targets: { ...allOff, diffpress: true },
      publishedAt: "2026-06-25T00:00:00.000Z",
    });
    expect(p).toEqual({
      title: "My Post", slug: "my-post", markdown: "body",
      canonicalUrl: "https://diffpress.com/my-post",
      publishedAt: "2026-06-25T00:00:00.000Z", series: "https://x/prev", repoName: "o/r",
    });
  });
  it("maps an empty seriesLink to null", () => {
    const p = buildWebhookPayload({
      title: "T", markdown: "b", repoName: "o/r", seriesLink: "",
      targets: { ...allOff, diffpress: true }, publishedAt: "2026-06-25T00:00:00.000Z",
    });
    expect(p.series).toBeNull();
  });
});

describe("selectedTargets", () => {
  it("returns only enabled ids", () => {
    expect(selectedTargets({ ...allOff, devto: true, thephilgray: true }))
      .toEqual(["devto", "thephilgray"]);
  });
});

describe("summarizeResults", () => {
  it("renders per-target ok/fail with names", () => {
    expect(summarizeResults([
      { id: "devto", ok: true, detail: "" },
      { id: "thephilgray", ok: false, detail: "503" },
    ])).toBe("Dev.to ✓ · thephilgray.com ✗");
  });
});

describe("parsePublishInput", () => {
  const ctx = (sub?: string) => ({ authorizer: sub ? { jwt: { claims: { sub } } } : undefined });
  const good = {
    repoName: "o/r", targets: { ...allOff, devto: true },
    timing: "now", scheduleAt: "", seriesLink: "",
  };
  it("rejects unauthenticated (401)", () => {
    const r = parsePublishInput({ requestContext: ctx(), body: JSON.stringify(good) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(401);
  });
  it("rejects a missing body (400)", () => {
    const r = parsePublishInput({ requestContext: ctx("u1"), body: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });
  it("rejects when no target is enabled (400)", () => {
    const r = parsePublishInput({ requestContext: ctx("u1"), body: JSON.stringify({ ...good, targets: allOff }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });
  it("accepts a well-formed request", () => {
    const r = parsePublishInput({ requestContext: ctx("u1"), body: JSON.stringify(good) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.repoName).toBe("o/r");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/diffpress/lib/publish.test.ts`
Expected: FAIL — `Cannot find module './publish'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/diffpress/lib/publish.ts
import { createHmac } from "node:crypto";

export type TargetId = "devto" | "diffpress" | "thephilgray" | "linkedin" | "substack";

export interface PublishTargets {
  devto: boolean;
  diffpress: boolean;
  thephilgray: boolean;
  linkedin: boolean;
  substack: boolean;
}

export interface PublishInput {
  repoName: string;
  targets: PublishTargets;
  timing: "now" | "schedule";
  scheduleAt: string;
  seriesLink: string;
}

export interface TargetResult {
  id: TargetId;
  ok: boolean;
  detail: string;
}

export interface WebhookPayload {
  title: string;
  slug: string;
  markdown: string;
  canonicalUrl: string;
  publishedAt: string;
  series: string | null;
  repoName: string;
}

const TARGET_NAMES: Record<TargetId, string> = {
  devto: "Dev.to",
  diffpress: "diffpress.com",
  thephilgray: "thephilgray.com",
  linkedin: "LinkedIn",
  substack: "Substack",
};

// Own-domain webhook targets and their canonical bases.
const DOMAIN_BASE: Record<"diffpress" | "thephilgray", string> = {
  diffpress: "https://diffpress.com",
  thephilgray: "https://thephilgray.com",
};

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function signWebhook(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function canonicalUrlFor(targets: PublishTargets, slug: string): string {
  const domains = (["diffpress", "thephilgray"] as const).filter((d) => targets[d]);
  const base = domains.length === 1 ? DOMAIN_BASE[domains[0]] : DOMAIN_BASE.diffpress;
  return `${base}/${slug}`;
}

export function buildWebhookPayload(args: {
  title: string;
  markdown: string;
  repoName: string;
  seriesLink: string;
  targets: PublishTargets;
  publishedAt: string;
}): WebhookPayload {
  const slug = slugify(args.title);
  return {
    title: args.title,
    slug,
    markdown: args.markdown,
    canonicalUrl: canonicalUrlFor(args.targets, slug),
    publishedAt: args.publishedAt,
    series: args.seriesLink.trim() === "" ? null : args.seriesLink,
    repoName: args.repoName,
  };
}

export function buildDevtoArticle(args: {
  title: string;
  markdown: string;
  canonicalUrl: string;
}): { article: { title: string; body_markdown: string; published: true; canonical_url: string } } {
  return {
    article: {
      title: args.title,
      body_markdown: args.markdown,
      published: true,
      canonical_url: args.canonicalUrl,
    },
  };
}

export function selectedTargets(targets: PublishTargets): TargetId[] {
  return (Object.keys(targets) as TargetId[]).filter((id) => targets[id]);
}

export function summarizeResults(results: TargetResult[]): string {
  return results
    .map((r) => `${TARGET_NAMES[r.id]} ${r.ok ? "✓" : "✗"}`)
    .join(" · ");
}

export function parsePublishInput(event: {
  requestContext?: any;
  body?: string | null;
}): { ok: true; value: PublishInput } | { ok: false; statusCode: number; message: string } {
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) return { ok: false, statusCode: 401, message: "Unauthorized" };
  if (!event.body) return { ok: false, statusCode: 400, message: "Missing request body" };

  let parsed: any;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body" };
  }

  const { repoName, targets, timing, scheduleAt, seriesLink } = parsed ?? {};
  if (typeof repoName !== "string" || repoName.trim() === "") {
    return { ok: false, statusCode: 400, message: "repoName is required" };
  }
  if (typeof targets !== "object" || targets === null) {
    return { ok: false, statusCode: 400, message: "targets is required" };
  }
  const norm: PublishTargets = {
    devto: !!targets.devto,
    diffpress: !!targets.diffpress,
    thephilgray: !!targets.thephilgray,
    linkedin: !!targets.linkedin,
    substack: !!targets.substack,
  };
  if (!selectedTargets(norm).length) {
    return { ok: false, statusCode: 400, message: "At least one target is required" };
  }
  if (timing !== "now" && timing !== "schedule") {
    return { ok: false, statusCode: 400, message: "timing must be 'now' or 'schedule'" };
  }
  return {
    ok: true,
    value: {
      repoName,
      targets: norm,
      timing,
      scheduleAt: typeof scheduleAt === "string" ? scheduleAt : "",
      seriesLink: typeof seriesLink === "string" ? seriesLink : "",
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/diffpress/lib/publish.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/lib/publish.ts src/diffpress/lib/publish.test.ts
git commit -m "feat(diffpress): pure publish helpers (slug, HMAC, payload builders)"
```

---

### Task 2: Ledger — `SCHEDULED` status + scheduling helpers

**Files:**
- Modify: `src/diffpress/types.ts` (PublicationStatus + PublicationRecord)
- Modify: `src/diffpress/lib/ledger.ts`
- Test: `src/diffpress/lib/ledger.scheduled.test.ts`

**Interfaces:**
- Consumes: `PublishTargets` from `./publish` (Task 1); existing `tableName()`, `STATUS_INDEX`, `docClient`, `queryByStatus` in `ledger.ts`.
- Produces:
  - `PublicationStatus` gains `"SCHEDULED"`.
  - `PublicationRecord` gains `scheduleAt?: string` and `targets?: PublishTargets` and `seriesLink?: string`.
  - `function buildMarkScheduledParams(table: string, repoName: string, meta: { scheduleAt: string; targets: PublishTargets; seriesLink: string }): UpdateCommandInput`
  - `async function markScheduled(repoName: string, meta: { scheduleAt: string; targets: PublishTargets; seriesLink: string }): Promise<void>`
  - `async function queryScheduledDue(nowIso: string): Promise<PublicationRecord[]>`

- [ ] **Step 1: Add `SCHEDULED` to the status union and record fields**

In `src/diffpress/types.ts`, change the `PublicationStatus` union (around line 90) to include `SCHEDULED`:

```typescript
export type PublicationStatus =
  | "DISCOVERED"
  | "AWAITING_HANDOFF"
  | "DRAFTING"
  | "SCHEDULED"
  | "PUBLISHED"
  | "DISMISSED";
```

Add these fields to `PublicationRecord` (after `publishedAt?: string;`, around line 109). Import `PublishTargets` at the top of the file:

```typescript
import type { PublishTargets } from "./lib/publish";
```

```typescript
  // Scheduling fields (status === "SCHEDULED")
  scheduleAt?: string;   // ISO 8601; when the cron should publish
  targets?: PublishTargets;
  seriesLink?: string;
```

- [ ] **Step 2: Write the failing test for the pure param builder**

```typescript
// src/diffpress/lib/ledger.scheduled.test.ts
import { describe, it, expect } from "vitest";
import { buildMarkScheduledParams } from "./ledger";

const targets = {
  devto: true, diffpress: false, thephilgray: true, linkedin: false, substack: false,
};

describe("buildMarkScheduledParams", () => {
  it("sets status SCHEDULED with scheduleAt, targets and seriesLink", () => {
    const p = buildMarkScheduledParams("T", "o/r", {
      scheduleAt: "2026-07-01T09:00:00.000Z", targets, seriesLink: "https://x/p",
    });
    expect(p.TableName).toBe("T");
    expect(p.Key).toEqual({ repoName: "o/r" });
    expect(p.ExpressionAttributeValues![":scheduled"]).toBe("SCHEDULED");
    expect(p.ExpressionAttributeValues![":scheduleAt"]).toBe("2026-07-01T09:00:00.000Z");
    expect(p.ExpressionAttributeValues![":targets"]).toEqual(targets);
    expect(p.ExpressionAttributeValues![":seriesLink"]).toBe("https://x/p");
  });
  it("does not overwrite an already-PUBLISHED item", () => {
    const p = buildMarkScheduledParams("T", "o/r", { scheduleAt: "x", targets, seriesLink: "" });
    expect(p.ConditionExpression).toContain("<> :published");
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/lib/ledger.scheduled.test.ts`
Expected: FAIL — `buildMarkScheduledParams is not a function`.

- [ ] **Step 4: Implement the ledger helpers**

In `src/diffpress/lib/ledger.ts`, add (near the other `buildMark*Params`). Import the type at the top: `import type { PublishTargets } from "./publish";`

```typescript
/** Pure: build an UpdateCommand input that flips an item to SCHEDULED. */
export function buildMarkScheduledParams(
  table: string,
  repoName: string,
  meta: { scheduleAt: string; targets: PublishTargets; seriesLink: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression:
      "SET #status = :scheduled, scheduleAt = :scheduleAt, targets = :targets, seriesLink = :seriesLink",
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":scheduled": "SCHEDULED",
      ":published": "PUBLISHED",
      ":scheduleAt": meta.scheduleAt,
      ":targets": meta.targets,
      ":seriesLink": meta.seriesLink,
    },
  };
}
```

Add the async wrappers near `markPublished`:

```typescript
export async function markScheduled(
  repoName: string,
  meta: { scheduleAt: string; targets: PublishTargets; seriesLink: string }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildMarkScheduledParams(tableName(), repoName, meta))
  );
}

/**
 * Return SCHEDULED items whose scheduleAt is at or before `nowIso`.
 * Queries the status GSI (no scan), then filters by time and re-reads each
 * full item (the GSI projects only board fields, not articleMarkdown).
 */
export async function queryScheduledDue(nowIso: string): Promise<PublicationRecord[]> {
  const scheduled = await queryByStatus("SCHEDULED");
  const due = scheduled.filter((r) => (r.scheduleAt ?? "") <= nowIso);
  const full = await Promise.all(due.map((r) => getByRepo(r.repoName)));
  return full.filter((r): r is PublicationRecord => r !== null);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/lib/ledger.scheduled.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/types.ts src/diffpress/lib/ledger.ts src/diffpress/lib/ledger.scheduled.test.ts
git commit -m "feat(diffpress): SCHEDULED ledger status + scheduling helpers"
```

---

### Task 3: Publish core + `POST /api/publish` handler

**Files:**
- Create: `src/diffpress/publishArticle.ts`

**Interfaces:**
- Consumes: `parsePublishInput`, `selectedTargets`, `summarizeResults`, `buildWebhookPayload`, `buildDevtoArticle`, `signWebhook`, `canonicalUrlFor`, types `PublishInput`/`TargetResult`/`PublishTargets`/`TargetId` (Task 1); `getByRepo`, `markPublished`, `markScheduled`, `PublicationRecord` (Task 2); `Resource.DEVTO_API_KEY`, `Resource.PUBLISH_WEBHOOKS` (Task 4 wires them).
- Produces:
  - `async function publishNow(record: PublicationRecord, targets: PublishTargets, seriesLink: string): Promise<{ results: TargetResult[]; summary: string }>` — used by both this handler and the cron (Task 5).
  - `async function handler(event): Promise<APIGatewayProxyResultV2>`

- [ ] **Step 1: Write the handler + core**

```typescript
// src/diffpress/publishArticle.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getByRepo, markPublished, markScheduled } from "./lib/ledger";
import type { PublicationRecord } from "./types";
import {
  parsePublishInput,
  selectedTargets,
  summarizeResults,
  buildWebhookPayload,
  buildDevtoArticle,
  canonicalUrlFor,
  signWebhook,
  slugify,
  type PublishTargets,
  type TargetId,
  type TargetResult,
} from "./lib/publish";

interface WebhookConfig {
  url: string;
  secret: string;
}

function webhookConfigs(): Partial<Record<"diffpress" | "thephilgray", WebhookConfig>> {
  try {
    return JSON.parse(Resource.PUBLISH_WEBHOOKS.value);
  } catch {
    return {};
  }
}

async function postDevto(
  title: string,
  markdown: string,
  canonicalUrl: string
): Promise<TargetResult> {
  try {
    const res = await fetch("https://dev.to/api/articles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": Resource.DEVTO_API_KEY.value,
      },
      body: JSON.stringify(buildDevtoArticle({ title, markdown, canonicalUrl })),
    });
    if (!res.ok) {
      return { id: "devto", ok: false, detail: `HTTP ${res.status}` };
    }
    return { id: "devto", ok: true, detail: "published" };
  } catch (err: any) {
    return { id: "devto", ok: false, detail: err?.message ?? "request failed" };
  }
}

async function postWebhook(
  id: "diffpress" | "thephilgray",
  record: PublicationRecord,
  targets: PublishTargets,
  seriesLink: string
): Promise<TargetResult> {
  const cfg = webhookConfigs()[id];
  if (!cfg?.url || !cfg?.secret) {
    return { id, ok: false, detail: "not configured" };
  }
  try {
    const rawBody = JSON.stringify(
      buildWebhookPayload({
        title: record.title ?? "",
        markdown: record.articleMarkdown ?? "",
        repoName: record.repoName,
        seriesLink,
        targets,
        publishedAt: new Date().toISOString(),
      })
    );
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DiffPress-Signature": signWebhook(rawBody, cfg.secret),
      },
      body: rawBody,
    });
    if (!res.ok) return { id, ok: false, detail: `HTTP ${res.status}` };
    return { id, ok: true, detail: "delivered" };
  } catch (err: any) {
    return { id, ok: false, detail: err?.message ?? "request failed" };
  }
}

/** Fan out to every enabled target. Shared by the handler and the scheduled cron. */
export async function publishNow(
  record: PublicationRecord,
  targets: PublishTargets,
  seriesLink: string
): Promise<{ results: TargetResult[]; summary: string }> {
  const canonicalUrl = canonicalUrlFor(targets, slugify(record.title ?? ""));
  const jobs: Promise<TargetResult>[] = selectedTargets(targets).map((id: TargetId) => {
    switch (id) {
      case "devto":
        return postDevto(record.title ?? "", record.articleMarkdown ?? "", canonicalUrl);
      case "diffpress":
      case "thephilgray":
        return postWebhook(id, record, targets, seriesLink);
      default:
        return Promise.resolve({ id, ok: false, detail: "not supported" });
    }
  });
  const results = await Promise.all(jobs);

  if (results.some((r) => r.ok)) {
    await markPublished(record.repoName, {
      title: record.title ?? "",
      publishedAt: new Date().toISOString(),
      articleMarkdown: record.articleMarkdown ?? "",
    });
  }
  return { results, summary: summarizeResults(results) };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parsePublishInput(event as any);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: JSON.stringify({ message: parsed.message }) };
  }
  const { repoName, targets, timing, scheduleAt, seriesLink } = parsed.value;

  try {
    const record = await getByRepo(repoName);
    if (!record || !record.articleMarkdown) {
      return { statusCode: 404, body: JSON.stringify({ message: "Article not found." }) };
    }

    if (timing === "schedule") {
      await markScheduled(repoName, { scheduleAt, targets, seriesLink });
      return {
        statusCode: 202,
        body: JSON.stringify({ scheduled: true, summary: `Scheduled for ${scheduleAt}` }),
      };
    }

    const { results, summary } = await publishNow(record, targets, seriesLink);
    return { statusCode: 200, body: JSON.stringify({ scheduled: false, results, summary }) };
  } catch (error: any) {
    console.error("[publishArticle] failed:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to publish article." }) };
  }
}
```

- [ ] **Step 2: Typecheck the handler (no `Resource` types until Task 4 deploys)**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "publishArticle" || echo "no publishArticle type errors"`
Expected: `no publishArticle type errors`. (If `Resource.DEVTO_API_KEY` / `Resource.PUBLISH_WEBHOOKS` are flagged as missing, that resolves after Task 4 runs `sst deploy`/`sst dev` to regenerate `sst-env.d.ts`. See the SST type-gen note in project memory.)

- [ ] **Step 3: Commit**

```bash
git add src/diffpress/publishArticle.ts
git commit -m "feat(diffpress): publish core + POST /api/publish handler"
```

---

### Task 4: SST wiring — secrets, route, cron

**Files:**
- Create: `src/diffpress/publishScheduled.ts`
- Modify: `sst.config.ts`

**Interfaces:**
- Consumes: `queryScheduledDue` (Task 2), `publishNow` (Task 3).
- Produces: secrets `DEVTO_API_KEY` + `PUBLISH_WEBHOOKS`; route `POST /api/publish`; cron `PublishScheduledCron` (handler `src/diffpress/publishScheduled.handler`).

- [ ] **Step 1: Write the scheduled-publish cron handler**

```typescript
// src/diffpress/publishScheduled.ts
import { queryScheduledDue } from "./lib/ledger";
import { publishNow } from "./publishArticle";

/** Cron: publish every SCHEDULED article whose scheduleAt is now due. */
export async function handler(): Promise<{ published: number }> {
  const due = await queryScheduledDue(new Date().toISOString());
  for (const record of due) {
    try {
      await publishNow(record, record.targets!, record.seriesLink ?? "");
      console.log(`[publishScheduled] published ${record.repoName}`);
    } catch (err) {
      console.error(`[publishScheduled] failed ${record.repoName}:`, err);
    }
  }
  return { published: due.length };
}
```

- [ ] **Step 2: Declare the two secrets**

In `sst.config.ts`, alongside the other `new sst.Secret(...)` lines (around line 12-20), add:

```typescript
    const DEVTO_API_KEY = new sst.Secret("DEVTO_API_KEY");
    const PUBLISH_WEBHOOKS = new sst.Secret("PUBLISH_WEBHOOKS");
```

- [ ] **Step 3: Add the publish route**

In `sst.config.ts`, immediately after the `POST /api/publish-handoff` route block (ends ~line 408), add:

```typescript
    api.route("POST /api/publish", {
      handler: "src/diffpress/publishArticle.handler",
      link: [auth, publicationLifecycle, DEVTO_API_KEY, PUBLISH_WEBHOOKS],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });
```

- [ ] **Step 4: Add the 5-minute scheduled-publish cron**

In `sst.config.ts`, after the `EventIngestCron` block (around line 676), add:

```typescript
    // Every 5 minutes — publish any SCHEDULED article whose time has come.
    const publishScheduledCron = new sst.aws.Cron("PublishScheduledCron", {
      schedule: "rate(5 minutes)",
      job: {
        handler: "src/diffpress/publishScheduled.handler",
        link: [publicationLifecycle, DEVTO_API_KEY, PUBLISH_WEBHOOKS],
        timeout: "60 seconds",
      },
    });
```

- [ ] **Step 5: Set the secret values (local — values supplied by Phil)**

```bash
npx sst secret set DEVTO_API_KEY "<dev.to api key>"
npx sst secret set PUBLISH_WEBHOOKS '{"diffpress":{"url":"https://diffpress.com/api/publish-hook","secret":"<s1>"},"thephilgray":{"url":"https://thephilgray.com/api/publish-hook","secret":"<s2>"}}'
```

Note: real values are Phil's to provide. If unknown at execution time, set placeholders and flag that publishing won't work until real values are set.

- [ ] **Step 6: Validate the SST graph + regenerate types**

Run: `npx sst diff 2>&1 | tail -30`
Expected: the diff lists the new `DEVTO_API_KEY`, `PUBLISH_WEBHOOKS`, `Api` route, and `PublishScheduledCron` with no errors.

Then run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "publishArticle|publishScheduled" || echo "no publish type errors"`
Expected: `no publish type errors` (Resource types now present).

- [ ] **Step 7: Commit**

```bash
git add sst.config.ts src/diffpress/publishScheduled.ts
git commit -m "feat(diffpress): wire publish route, secrets, and scheduled-publish cron"
```

---

### Task 5: Frontend types + defaults

**Files:**
- Modify: `src/components/diffpress/types.ts`
- Modify: `src/components/diffpress/data.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SyndicationTargets = { devto; diffpress; thephilgray; linkedin; substack }` (all `boolean`).
  - `DeployPayload` drops `articleId`, adds `repoName: string`.
  - `interface PublishTargetResult { id: keyof SyndicationTargets; ok: boolean; detail: string }`
  - `interface DeployResponse { scheduled: boolean; summary: string; results?: PublishTargetResult[] }`
  - `EMPTY_DEPLOY.targets` updated to the new shape.

- [ ] **Step 1: Update the target + payload types**

In `src/components/diffpress/types.ts`, replace the `SyndicationTargets` and `DeployPayload` interfaces (lines 82-95):

```typescript
export interface SyndicationTargets {
  devto: boolean;
  diffpress: boolean;
  thephilgray: boolean;
  linkedin: boolean;
  substack: boolean;
}

export interface PublishTargetResult {
  id: keyof SyndicationTargets;
  ok: boolean;
  detail: string;
}

export interface DeployPayload {
  repoName: string;
  targets: SyndicationTargets;
  timing: Timing;
  scheduleAt: string;
  seriesLink: string;
}

export interface DeployResponse {
  scheduled: boolean;
  summary: string;
  results?: PublishTargetResult[];
}
```

- [ ] **Step 2: Update `EMPTY_DEPLOY`**

In `src/components/diffpress/data.ts` (lines 24-29):

```typescript
export const EMPTY_DEPLOY: Omit<DeployPayload, "repoName"> = {
  targets: { devto: true, diffpress: true, thephilgray: false, linkedin: false, substack: false },
  timing: "now",
  scheduleAt: "",
  seriesLink: "",
};
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "diffpress/(types|data|store|services|PublishConsole)" || echo "expected errors only in store/services/PublishConsole (fixed in Tasks 6-7)"`
Expected: errors only in `store.ts`, `services.ts`, `PublishConsole.tsx` (they still reference the old shape — fixed next). `types.ts` and `data.ts` themselves clean.

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/types.ts src/components/diffpress/data.ts
git commit -m "feat(diffpress): per-domain syndication targets + deploy response types"
```

---

### Task 6: Frontend service — real `deployArticle`

**Files:**
- Modify: `src/components/diffpress/services.ts` (replace the mock at lines 245-263)

**Interfaces:**
- Consumes: `DeployPayload`, `DeployResponse` (Task 5); `authedFetch`.
- Produces: `async function deployArticle(payload: DeployPayload): Promise<DeployResponse>`.

- [ ] **Step 1: Replace the mock with a real API call**

In `src/components/diffpress/services.ts`, replace the entire `deployArticle` function (lines 245-263) with:

```typescript
export async function deployArticle(payload: DeployPayload): Promise<DeployResponse> {
  const res = await authedFetch("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to publish (${res.status})`);
  return res.json();
}
```

Add `DeployResponse` to the type import block at the top of the file (it imports `DeployPayload` already). Remove the now-unused `delay` import only if nothing else uses it — check with `grep -n "delay(" src/components/diffpress/services.ts`; keep it if other stubs still call it.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "diffpress/services" || echo "services clean"`
Expected: `services clean`.

- [ ] **Step 3: Commit**

```bash
git add src/components/diffpress/services.ts
git commit -m "feat(diffpress): real deployArticle calling POST /api/publish"
```

---

### Task 7: Frontend store wiring + per-target results UI

**Files:**
- Modify: `src/components/diffpress/store.ts` (deploy action, lines 524-536; state fields)
- Modify: `src/components/diffpress/PublishConsole.tsx` (TARGETS list + success panel)

**Interfaces:**
- Consumes: `deployArticle` (Task 6); `DeployResponse`, `PublishTargetResult`, `SyndicationTargets` (Task 5); `articleRepo` already in store state.
- Produces: store exposes `deployResults: PublishTargetResult[]`; `deploy()` sends `repoName` and stores results.

- [ ] **Step 1: Add `deployResults` to store state + type**

In `src/components/diffpress/store.ts`, add to the state interface (near `deploySummary: string;`, ~line 162):

```typescript
  deployResults: PublishTargetResult[];
```

Import `PublishTargetResult` in the type import block (line 27 area) and initialise it in the store object (near `deploySummary: "",`, ~line 510):

```typescript
  deployResults: [],
```

- [ ] **Step 2: Rewrite the `deploy` action to pass `repoName` and capture results**

Replace the `deploy` action (lines 524-536) with:

```typescript
  deploy: async () => {
    const { targets, timing, scheduleAt, seriesLink, articleRepo } = get();
    if (!Object.values(targets).some(Boolean)) return;
    if (!articleRepo) return;
    set({ deploying: true });
    try {
      const res = await deployArticle({
        repoName: articleRepo,
        targets,
        timing,
        scheduleAt,
        seriesLink,
      });
      set({
        deploying: false,
        deployed: true,
        deploySummary: res.summary,
        deployResults: res.results ?? [],
      });
    } catch (err) {
      set({
        deploying: false,
        deployed: true,
        deploySummary: "Publish failed — see console.",
        deployResults: [],
      });
      console.error("[deploy] failed:", err);
    }
  },
```

- [ ] **Step 3: Update the target list in `PublishConsole.tsx`**

In `src/components/diffpress/PublishConsole.tsx`, replace the `portfolio` entry in the `TARGETS` array (lines 39-44) with the two own-domain webhooks, and import a globe icon (`Globe`) from `lucide-react`:

```typescript
  {
    id: "diffpress",
    name: "diffpress.com",
    desc: "Signed webhook to your DiffPress site",
    icon: <Globe size={19} strokeWidth={1.7} />,
  },
  {
    id: "thephilgray",
    name: "thephilgray.com",
    desc: "Signed webhook to your personal site",
    icon: <Globe size={19} strokeWidth={1.7} />,
  },
```

Update the `lucide-react` import line (line 2-8) to add `Globe` and drop `LayoutDashboard` (now unused):

```typescript
import { Check, Globe, Linkedin, Mail, SquareCode, X } from "lucide-react";
```

- [ ] **Step 4: Render per-target ✓/✗ in the success panel**

In `PublishConsole.tsx`, subscribe to results near the other selectors (~line 52):

```typescript
  const deployResults = useDiffPress((s) => s.deployResults);
```

In the `deployed` success panel, replace the single summary paragraph (lines 87-89) with a per-target list that falls back to the summary when there are no per-target results (e.g. scheduled):

```tsx
            {deployResults.length ? (
              <ul className="mb-6 inline-block text-left text-[14px] leading-[1.8] text-dp-muted">
                {deployResults.map((r) => (
                  <li key={r.id}>
                    <span className={r.ok ? "text-dp-green" : "text-red-500"}>
                      {r.ok ? "✓" : "✗"}
                    </span>{" "}
                    {r.id}
                    {r.ok ? "" : ` — ${r.detail}`}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mb-6 text-[14px] leading-[1.6] text-dp-muted">{deploySummary}</p>
            )}
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "diffpress" || echo "diffpress clean"`
Expected: `diffpress clean`.

Run: `npm run build 2>&1 | tail -5`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add src/components/diffpress/store.ts src/components/diffpress/PublishConsole.tsx
git commit -m "feat(diffpress): publish console wires repoName + per-target results"
```

---

### Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the whole diffpress test suite**

Run: `npx vitest run src/diffpress`
Expected: PASS, including the new `publish.test.ts` and `ledger.scheduled.test.ts`.

- [ ] **Step 2: Typecheck the whole project**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Deploy (Phil-gated) + live smoke test**

This step is Phil's to run when ready (it deploys to AWS and posts to real services). Document the manual checks; do not auto-deploy:

```bash
npx sst deploy --stage <stage>
```

Then in the editor UI:
1. Open a published/draft article, click Deploy with **Dev.to** only → expect a real dev.to draft/post and `Dev.to ✓`.
2. Deploy with **diffpress.com** enabled against a test receiver → receiver verifies the HMAC and accepts; UI shows `diffpress.com ✓`.
3. Toggle **LinkedIn** → expect `✗ — not supported` without blocking other targets.
4. Choose **Schedule** a minute out → confirm a `SCHEDULED` ledger record, then that the cron flips it to `PUBLISHED` within ~5 min.

---

## Notes for the implementer

- **SST type-gen gotcha (project memory):** `npx sst diff` can clobber `sst-env.d.ts` and break `tsc`. If `Resource.DEVTO_API_KEY`/`PUBLISH_WEBHOOKS` types go missing, re-run `npx sst dev`/`sst deploy` to regenerate them. Don't hand-edit `sst-env.d.ts`.
- **BOARD_PROJECTION:** this plan does not surface SCHEDULED on the kanban board (out of scope). If a SCHEDULED card should appear, add `scheduleAt` to `BOARD_PROJECTION` in `ledger.ts` and map the status in `listHandoffs.ts` — the projection silently drops unlisted fields (recurring sharp edge).
- **Dev.to series:** intentionally not set — Dev.to's `series` is a name, `seriesLink` is a URL. `seriesLink` rides in the webhook payload only.
```
