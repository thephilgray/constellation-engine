# DiffPress Publishing Pipeline — Design

**Date:** 2026-06-25
**Status:** Approved (pending spec review)

## Problem

`deployArticle` (in `src/components/diffpress/services.ts`) is a pure mock: it
delays 900ms and returns a summary string. Nothing is published anywhere. The
Deploy button in `PublishConsole` looks real but does nothing.

We want to publish a finished article to:

- **Dev.to** — real API.
- **Own domains** (diffpress.com, thephilgray.com) — both are static-site repos.
  Publishing happens via a **generic outbound webhook**: DiffPress POSTs the
  article as signed JSON to a configured URL per domain; each site implements
  its own receiver (e.g. commit `<slug>.md` to its repo, which auto-deploys).
- **LinkedIn / Substack** — keep the UI toggles, but they remain stubs (no
  usable publish API: LinkedIn's is gated, Substack has none).

Publishing supports **publish now** or **schedule for later**.

## Approach (chosen: A)

A standalone, authenticated `publishArticle` Lambda behind the existing HTTP API
replaces the mock. The Deploy button calls it; it loads the article from the
ledger and fans out to enabled targets inline, returning per-target results.

Rejected alternatives:
- **B — into the Step Functions pipeline.** The manual Deploy button doesn't map
  onto a state-machine execution; you'd start/resume an execution just to POST
  two webhooks. Couples the autonomous pipeline to a manual action.
- **C — SQS fan-out with per-target retry queues.** Over-built for a personal
  tool with two real targets.

## Components

### 1. Publish core + Lambda — `src/diffpress/publishArticle.ts`

Behind the existing authenticated HTTP API (same auth as `publishHandoff`).

- **Input:** `{ repoName, targets, timing, scheduleAt, seriesLink }`.
- Loads `articleMarkdown` + `title` from the **ledger** by `repoName` (ledger is
  source of truth — the frontend never ships the article body).
- `timing === "schedule"` → write schedule fields to the ledger record
  (`status: "SCHEDULED"`, `scheduleAt`, `targets`, `seriesLink`), return
  `{ scheduled: true, summary }`.
- `timing === "now"` → fan out to enabled targets, collect per-target
  `{ id, ok, detail }`, mark ledger `PUBLISHED` if **any** target succeeded,
  return `{ results, summary }`.

Pure helpers (no AWS/network) are unit-tested: input parsing, target selection,
summary string, slug derivation, HMAC signature.

### 2. Target adapters (one pure-ish function each)

- **devto** → `POST https://dev.to/api/articles`, header `api-key: <DevtoApiKey>`.
  Body: `{ article: { title, body_markdown, published: true, canonical_url,
  tags, series } }`. `canonical_url` = the own-domain the post is published to
  (diffpress.com when ambiguous — see Canonical URL below).
- **webhook** (diffpress / thephilgray) → signed `POST` to the configured URL
  (see Webhook contract).
- **linkedin / substack** → stub adapters returning
  `{ ok: false, detail: "not supported" }`. Honest toggles, no faked success.

A failing target does not abort the others; each result is independent.

### 3. Scheduling — `src/diffpress/publishScheduled.ts`

A 5-minute SST `Cron` Lambda. Scans the ledger for
`status === "SCHEDULED" && scheduleAt <= now`, calls the publish core with
`timing: "now"` for each due record.

`// ponytail: 5-min cron-scan, not dynamic EventBridge schedules — reuses the`
`// ledger, no per-schedule IAM role. Ceiling: ~5-min latency, fine for posts.`

**Lifecycle note:** add `SCHEDULED` to `PublicationStatus`. `BOARD_PROJECTION`
must map the new status (recurring sharp edge: projection silently dropping
fields). Decide where a SCHEDULED card appears on the board — simplest is to keep
it in the DRAFTING lane visually until it publishes.

### 4. Config / secrets (SST secrets — no DB-backed config UI)

- `DevtoApiKey` — SecureString.
- `PublishWebhooks` — one shared JSON secret:
  `{ "diffpress": { "url": "...", "secret": "..." }, "thephilgray": { "url": "...", "secret": "..." } }`.

The frontend keeps its small fixed target list (it's a known personal set); URLs
and keys never reach the client.

### 5. Frontend — `services.ts` + `store.ts` + `PublishConsole.tsx`

- Replace the `deployArticle` mock with a real fetch to the publish endpoint;
  pass `repoName` (currently not passed — `store.deploy()` must include it).
- Render **per-target ✓/✗** in the success panel. Dev.to can fail while a
  webhook succeeds; a single summary string would hide partial failure.

## Webhook contract (for building the receivers)

```
POST <configured url>
Content-Type: application/json
X-DiffPress-Signature: sha256=<hex HMAC-SHA256(rawBody, secret)>

{
  "title": string,
  "slug": string,            // derived from title
  "markdown": string,
  "canonicalUrl": string,
  "publishedAt": string,     // ISO 8601
  "series": string | null,   // seriesLink, if provided
  "repoName": string
}
```

Receiver recomputes the HMAC over the raw body with its shared secret, rejects on
mismatch, then does whatever it wants with the payload.

## Canonical URL

`canonicalUrl` is the own-domain the post is published to. If publishing to a
single own-domain webhook, that domain. If publishing to multiple (or to dev.to
without an own-domain target), default to **diffpress.com** as the canonical
home. Slug derived from the title (lowercase, hyphenated, stripped).

## Out of scope

- LinkedIn / Substack real integrations (no API).
- A CRUD UI for managing publish destinations (secrets cover the fixed set).
- Wiring the autonomous Step Functions pipeline to syndicate (manual Deploy
  only, for now).

## Success criteria

- Clicking Deploy with Dev.to enabled creates a real draft/post on dev.to.
- Clicking Deploy with a domain enabled delivers a signed POST that a test
  receiver verifies (HMAC matches) and accepts.
- A failing target is reported as ✗ without blocking successful targets.
- Scheduling a post writes a SCHEDULED record; the cron publishes it within
  ~5 min of `scheduleAt`.
- Pure helpers (parse, select, summary, slug, HMAC) have unit tests that fail if
  the logic breaks.
