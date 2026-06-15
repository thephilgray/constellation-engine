# DiffPress UI ↔ Content Engine Backend Integration — Design

**Date:** 2026-06-15
**Status:** Approved (brainstormed). Builds on the merged Content Engine backend
(`docs/superpowers/specs/2026-06-14-diffpress-content-engine-design.md`, commit `3d17d76`).

## Problem

The DiffPress Content Engine backend is merged but unwired to the UI. Two concrete gaps:

1. **No way to read pending handoffs.** The Step Functions workflow pauses at a task-token
   state; `notifyHandoff` persists an `AWAITING_HANDOFF` ledger item carrying the `taskToken`,
   but nothing exposes it. The UI therefore cannot obtain the `taskToken` required to call
   `POST /api/publish-handoff`.
2. **The drafted article is never persisted.** `draftArticle` returns the article into Step
   Functions state; `recordPublication` writes only `title`/`publishedAt`/`status` to the
   ledger. The markdown evaporates, so the UI's In-Review view has no real content to render.

The frontend (`src/components/diffpress/`) is a polished React island at `/diffpress` driven by
Zustand + four async service stubs returning mock data. The mock UI models a much larger product
(discovery board, drafting progress, an SSE "AI Tech Editor", a syndication/deploy console) than
the backend implements.

## Scope (decided)

Wire the **handoff loop** and **persist + display the real article (read-only)**. Surfaces with
no backend are **hidden/disabled** rather than faked.

| UI surface | Source after this change |
|---|---|
| Ready for Dev column + handoff drawer | **Real** — `AWAITING_HANDOFF` ledger items (`taskToken`, `repoUrl`) via new `GET /api/handoffs` |
| Resume workflow | **Real** — existing `POST /api/publish-handoff`, given the real `taskToken` |
| In Review column | **Real** — `PUBLISHED` ledger items |
| In Review → article view | **Real, read-only** — persisted markdown via new `GET /api/articles?repo=…` |
| Discovery, Drafting columns | Mock/decorative (no queryable source) |
| Marginalia AI Tech Editor (SSE) | **Disabled** (no backend; SSE awkward on this API Gateway) |
| Publish / syndication console | **Disabled** (no backend; deploy already happened implicitly at resume) |

`taskToken` is returned to the browser — consistent with the existing design, which already
requires the browser to supply it to `publish-handoff`. Both endpoints sit behind the Cognito
JWT authorizer.

## Backend changes

1. **Persist the article** (`src/diffpress/lib/ledger.ts` + `recordPublication.ts`):
   `buildMarkPublishedParams`/`markPublished` also `SET articleMarkdown`; `recordPublication`
   passes `state.article.articleMarkdown` through. Article is a few KB — well under DynamoDB's
   400KB item limit; storing the final artifact in the publication record keeps the read path to
   one `GetCommand` (reuses the previously-unused `getByRepo`).

2. **`GET /api/handoffs`** (`src/diffpress/listHandoffs.ts`, mirrors `src/functions/dashboard.ts`):
   JWT-claims check → `listBoardItems()` (one `Scan`, projection excludes `articleMarkdown`) →
   bucket by `status`, return `{ readyForDev: [{repoName,repoUrl,taskToken,discoveredAt}],
   inReview: [{repoName,title,publishedAt}] }`.

3. **`GET /api/articles?repo=<owner/name>`** (`src/diffpress/getArticle.ts`): JWT check, read
   `repo` from `queryStringParameters` (query param — `repoName` contains a slash), reuse
   `getByRepo`, return `{repoName,title,articleMarkdown,publishedAt,status}` or 404.

4. **Wire both routes in `sst.config.ts`** beside `POST /api/publish-handoff`, JWT-authorized,
   `link: [auth, publicationLifecycle]` (table access; no explicit `permissions` block).

Pure helpers (`bucketBoard`, `parseRepoQuery`) are extracted for unit testing, mirroring
`publishHandoff.ts`'s `parseHandoffEvent` pattern.

## Frontend changes

1. **`src/lib/authedApi.ts`** — shared `authedFetch(path, init)` extracting the inline
   `fetchAuthSession()` → `Bearer` pattern from `DashboardViewer.tsx`. Importing it also triggers
   `Amplify.configure` (side-effect of importing `@/lib/amplify`).

2. **`services.ts`** — real `fetchCandidates` (→ `GET /api/handoffs`; real `readyForDev` +
   `inReview`, mock `discovery` + `drafting`), `publishHandoff({taskToken,repoUrl,devLog})`
   (→ `POST /api/publish-handoff`), new `fetchArticle(repoName)` (→ `GET /api/articles`). The
   `deployArticle` / `triggerTechEditor` stubs remain but are never invoked.

3. **`store.ts`** — `HandoffCard` carries `taskToken`/`repoUrl` from the board; `submitResume`
   sends the real token then optimistically removes the card (the workflow auto-drafts/publishes
   async; the item reappears in In-Review on next `loadPipeline`). New `openArticle(repoName)`
   loads markdown via `fetchArticle`. `setEditorMode` no longer starts the Tech Editor.

4. **Components** — `DiffPress.tsx` calls `loadPipeline()` on mount (it currently never does);
   `Editor.tsx` renders a new read-only `ArticleView` (react-markdown) instead of
   `DraftEditor`/`ReviewArticle`; `Dashboard.tsx` In-Review card → `openArticle(card.id)`;
   `TopBar.tsx` disables the Review tab. The Publish console becomes unreachable (its only
   trigger lived in `ReviewArticle`).

## Verification

1. `npx tsc --noEmit` clean; `npx vitest run` (existing 10 + new ledger/handler tests) green;
   `sst diff` synthesizes the two new routes (guard against `sst-env.d.ts` clobber).
2. End-to-end (after `sst deploy`): trigger the engine → pause → `/diffpress` shows the repo in
   Ready-for-Dev → submit URL+log → `202` → workflow drafts & publishes → reload → item in
   In-Review → open it → real article renders read-only → Marginalia + Publish are disabled.

## Out of scope / deferred
- Tech Editor backend (SSE/polled) and syndication/deploy backend.
- Discovery/Drafting persistence.
- A dedicated `/diffpress` login flow (relies on the shared Cognito session from the main app).
