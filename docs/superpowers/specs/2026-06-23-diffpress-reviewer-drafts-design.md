# DiffPress: Real Reviewer + General Feedback + Drafts + Autosave

**Date:** 2026-06-23
**Status:** Design approved, pending implementation plan

## Problem

After the Resume Workflow drafts an article, the editor can save edits but:

- The "AI Tech Editor" reviewer (`ReviewArticle.tsx`) is entirely mock — a hardcoded
  "Helix" article, a `TECH_EDITOR_NOTES` constant, and a fake `triggerTechEditor` SSE
  simulation. The Review tab is hardcoded-disabled (`store.ts:163`).
- There is no way to give the model general feedback ("make it punchier", "cut the intro")
  and get a revised article.
- Every save overwrites `articleMarkdown` in place in DynamoDB — no version history.
- There is no autosave; edits persist only on an explicit button press.

## Core insight

All four asks are one revision loop on top of a save path that currently overwrites in
place. Unify them: **every article mutation — manual save, autosave, "apply note",
"revise whole article" — funnels through one save that writes a versioned S3 draft and
updates the DynamoDB "current".** Drafts are the spine; the reviewer and the revise box
are just things that produce new drafts.

## Decisions (locked)

| Question | Decision |
|---|---|
| Reviewer shape | Real critique with per-note proposed change + apply + per-note pushback + publish gating |
| Note placement | **Side panel of note cards** (no DOM anchoring — see below) |
| Note anchoring | `anchorText` is a verbatim snippet used as *data* (for Apply + display), **not** for DOM positioning |
| Pushback | Real per-note conversation with the LLM (may revise the proposed change) |
| General feedback | Separate global "revise whole article" box |
| Reviewer trigger | On-demand "Run AI review" button |
| Draft storage | S3 timestamped objects in the existing `ContentPayloadBucket` |
| Autosave | Debounced (~2s after input), alongside manual save |

### Why no DOM anchoring

`anchorText` has two possible uses. (1) **As data for Apply:** applying a note string-replaces
`anchorText → replacement` in the markdown — a pure string op, needed regardless; if the
snippet isn't found, Apply is disabled for that note. (2) **As DOM positioning:** walking
rendered text nodes to float a margin dot next to the exact paragraph — brittle (breaks on
duplicate/paraphrased text), expensive bounding-rect math, the one real risk in the plan.

We keep (1) and drop (2). The reviewer renders the article read-only with a **side panel** of
note cards; each card shows the quoted snippet (so you see what it refers to), the critique,
the before→after diff, Apply, and pushback. This delivers the full critique-and-apply loop
and loses only the cosmetic marginalia placement. Inline positioning, if later wanted, is a
purely additive enhancement.

## Data model

- **DynamoDB item stays the "current/latest"** (`articleMarkdown` + `title`). `getArticle`
  and the board are untouched.
- **Drafts → S3 timestamped objects:** key `drafts/${repoName}/${isoTs}.json`, body
  `{ savedAt, title, articleMarkdown }`. Listing the prefix = version history. (Timestamped
  keys rather than S3 native versioning: the bucket isn't versioned, and listing keys is
  simpler than listing object versions.)
- **Review notes are NOT persisted.** They live in the frontend store for the session;
  reload re-runs the review. (Deliberate simplification; persistence is a later add.)

## Backend

API pattern (existing): `api.route("METHOD /path", { handler, link:[auth, ...resources],
timeout }, { auth:{ jwt } })`, single JWT authorizer. Gemini pattern (existing in
`draftArticle.ts`): `@google/genai`, `Resource.GEMINI_API_KEY`, model `gemini-2.5-pro`,
structured JSON output via `responseSchema`, lazy client init, pure prompt-builders +
response-parsers exported for unit tests.

### 1. `src/diffpress/lib/draftStore.ts` (new)

Mirrors `payloadStore.ts`. Functions:

- `putDraft(repoName, { title, articleMarkdown })` → writes `drafts/${repoName}/${isoTs}.json`,
  returns the `ts`.
- `listDrafts(repoName)` → returns `{ ts }[]` newest-first, parsed from the S3 key names only
  (no per-object read). Restoring a specific draft fetches its full body separately.
- `getDraft(repoName, ts)` → returns `{ savedAt, title, articleMarkdown }`.

### 2. `src/diffpress/saveArticle.ts` (modify)

After the existing DynamoDB update (`ledger.saveArticle`), also call
`putDraft(repo, { title, articleMarkdown })`. Every save produces a new draft automatically.
The route's `link` gains `ContentPayloadBucket`. The Dynamo write is the source of truth;
the draft write is awaited after it so a draft failure surfaces as a 500 rather than passing
silently.

### 3. `src/diffpress/articleDrafts.ts` (new) → `GET /api/articles/drafts`

- `?repo=` → `listDrafts` → `{ drafts: [{ ts }] }`.
- `?repo=&ts=` → `getDraft` → `{ ts, savedAt, title, articleMarkdown }`.

Auth + repo validation mirror `getArticle.ts`. One Lambda, `?ts=` discriminates list vs fetch.

### 4. `src/diffpress/articleAI.ts` (new) → `POST /api/articles/ai`

Single handler with an `action` discriminator (mirrors `boardAction.ts`). Linked to
`GEMINI_API_KEY` (and `auth`). All prompt-builders and response-parsers are pure and exported.

- `action: "review"` — input `{ repo, articleMarkdown }`; Gemini returns
  `{ notes: [{ id, anchorText, note, replacement }] }`. `anchorText` MUST be a verbatim
  substring of the article (prompt instructs: copy exactly, do not paraphrase). `replacement`
  is the proposed new text for that span. `note` is the critique.
- `action: "reply"` — input `{ articleMarkdown, note, conversation: string[], message }`;
  Gemini responds to the pushback and MAY return a revised `replacement`. Output
  `{ reply, replacement? }`.
- `action: "revise"` — input `{ repo, articleMarkdown, instruction }`; Gemini returns the full
  rewritten `{ title, articleMarkdown }`.

The reviewer is **not streamed**: one response carries all notes; the frontend reveals them
progressively for the same feel. (Real SSE-from-Lambda is disproportionate effort for a
cosmetic gain; deferred.)

### 5. `sst.config.ts` (modify)

- Add `ContentPayloadBucket` to the `PUT /api/articles` route `link`.
- New route `GET /api/articles/drafts` → `articleDrafts.handler`, link `[auth,
  publicationLifecycle, ContentPayloadBucket]`.
- New route `POST /api/articles/ai` → `articleAI.handler`, link `[auth, GEMINI_API_KEY]`,
  timeout long enough for a full rewrite (e.g. `"120 seconds"`, matching the draft step).

## Frontend

### `src/components/diffpress/types.ts` (modify)

Add `ReviewNote = { id, anchorText, note, replacement }`, `DraftMeta = { ts }`, and the
request/response shapes for the AI endpoint.

### `src/components/diffpress/services.ts` (modify)

Replace the mock `triggerTechEditor` SSE simulation and add real calls:

- `runReview(repo, articleMarkdown)` → `POST /api/articles/ai` `{ action:"review" }`.
- `replyToNote({ articleMarkdown, note, conversation, message })` → `{ action:"reply" }`.
- `reviseArticle(repo, articleMarkdown, instruction)` → `{ action:"revise" }`.
- `listDrafts(repo)` / `getDraft(repo, ts)` → `GET /api/articles/drafts`.

### `src/components/diffpress/store.ts` (modify)

Replace `TECH_EDITOR_NOTES`-driven note state with real notes from the API. Add:

- `runReview()` — serialize current editor content, call `runReview`, store returned notes.
- `replyToNote(id, message)` — append to that note's chat, call `replyToNote`, update the
  note's `replacement` if the model revised it.
- `applyNote(id)` — string-replace `anchorText → replacement` in `articleMarkdown`; if found,
  trigger `saveArticle()` (which writes a new draft) and mark the note resolved; if not found,
  no-op with Apply disabled in the UI. Pure replace logic extracted + unit-tested.
- `reviseArticle(instruction)` — call `reviseArticle`, load the returned article into the
  editor, save (new draft).
- `loadDrafts()` / `restoreDraft(ts)` — restore loads the draft body into the editor (and a
  subsequent save snapshots it as the new latest).
- **Debounced autosave** — ~2s after the last input, reusing the existing `articleSaving` /
  `articleSaved` flags with an in-flight guard (skip/reschedule while a save is in flight).
- Un-disable the Review tab (`setEditorMode` no longer a no-op for `"review"`).

### `src/components/diffpress/ReviewArticle.tsx` (rewrite)

Render the **real** article markdown read-only (reuse `mdToHtml`), with a **side panel** of
note cards. Each card: AI Tech Editor label, the quoted `anchorText` as context, the critique,
a before→after diff block (`anchorText` removed → `replacement` added, reusing `DiffBlock`
styling), a pushback input, and "Apply edit & resolve". Apply is disabled when `anchorText`
isn't found in the current article. Publish gating: enabled when there are **no unresolved
notes** (review not run → nothing outstanding → publishable; review run → resolve all first).

### `src/components/diffpress/DraftEditor.tsx` (modify)

- Debounced autosave wired to input.
- "Run AI review" button (serializes current HTML→md, calls `runReview`, switches to Review
  mode).
- Global "Tell the editor what to change…" revise box (calls `reviseArticle`).
- A drafts/version list (calls `loadDrafts`; each entry restores via `restoreDraft(ts)`).

### Retire

`TECH_EDITOR_NOTES` mock and the fake `triggerTechEditor` simulation in `data.ts`/`services.ts`.

## Testing (one runnable check per non-trivial unit)

- `draftStore`: key building + `listDrafts` newest-first ordering from a key list.
- `articleAI`: pure prompt-builders + response-parsers (valid JSON, missing fields, empty
  output) — mirrors `draftArticle.test.ts`.
- `applyNote` replace logic: `anchorText` found → replaced once; not found → unchanged +
  flagged.
- `saveArticle.test.ts` (extend): save still updates Dynamo and now also writes a draft.

## Known risks

- **Verbatim `anchorText`.** If the model paraphrases instead of copying, Apply for that note
  is disabled (the note + critique still show). Mitigation: prompt instructs verbatim copy;
  fallback is honest (disabled Apply), not silent corruption.
- **Notes not persisted.** Reload loses session notes; re-run review. Accepted.

## Phasing (plan will stage; spec covers all)

- **A — Drafts + autosave:** `draftStore`, `saveArticle` writes a draft, `GET
  /api/articles/drafts`, drafts list/restore UI, debounced autosave. Self-contained, ships value.
- **B — Revise box:** `revise` action + global box → whole-article rewrite → new draft. Small,
  builds on A.
- **C — Real reviewer:** `review` + `reply` actions, side-panel `ReviewArticle` rewrite, apply,
  pushback, publish gating. Largest.
