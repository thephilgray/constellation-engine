# draftArticle: real LLM drafting (demo-centric, notes-driven)

**Date:** 2026-06-15
**Status:** Approved (design)
**Scope:** `src/diffpress/draftArticle.ts` + a new `src/diffpress/lib/devNotes.ts`, plus linking `GITHUB_TOKEN` to the `draftArticle` function in `sst.config.ts`.

## Problem

`draftArticle.ts` is the Content Engine's drafting stage. Today its `composeArticle`
helper returns a template string ("A Critical Read of X" with the docs and developer
log pasted under headings). Everything around it is real: Step Functions orchestration,
the S3 enrichment payload, the human-in-the-loop handoff, and the ledger write. This
spec replaces the template with a real Gemini call that produces a publishable article.

## Concept

The article is **demo-project-centric**. The pipeline (`discoverRepos`) surfaces an
emerging OSS repo or new release; the author then builds a *demo project* that uses it
and writes notes about the experience. The article covers that work, and supports two
deliberate modes:

- **explainer** — neutral, informative coverage of the OSS repo; the demo is not the focus.
- **narrative** — the story of building the demo project that happened to use this OSS
  repo/release; demo-centric, with the OSS repo as a supporting subject.

The author's notes drive both the content and which mode is used.

## Data flow (already in place — no changes needed)

The state machine threads a `ContentEngineState` (`src/diffpress/types.ts`):

- `state.repo` — the discovered OSS repo (subject): `repoName`, `repoUrl`, `description`,
  `stars`, `language`.
- `state.enrichment` — `PayloadLocation` for the S3 `EnrichmentPayload`
  (`documentation`, `sentiment[]`).
- `state.handoff` — `{ repoUrl, developerLog }`, where **`repoUrl` is the author's demo
  project URL** (collected by the handoff drawer's "GitHub URL" field) and
  `developerLog` is free text typed in the UI.

No type, handoff, or UI changes are required for this work.

## Design

### Model & client

- `gemini-2.5-pro` via `@google/genai`, instantiated at module level
  (`const genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value })`), matching
  `src/fiction.ts` / `src/philosopher.ts`. The function stays self-contained rather than
  importing `utils.ts`'s private `getGenAI()`, keeping its bundle lean.
- **Structured JSON output**: `config.responseMimeType = "application/json"` with a
  `responseSchema` for `{ title: string, articleMarkdown: string }`, so the title (stored
  and displayed separately in the ledger/UI) is reliable rather than parsed from a heading.
- The article body is passed through `sanitizeMarkdown()` (from `src/utils.ts`), as the
  other modules do. `draftedAt` is set server-side.

### Notes sourcing (primary → fallback)

1. Fetch a conventional **`DIFFPRESS.md`** from the demo repo root via Octokit, parsing
   `owner/repo` from `handoff.repoUrl`. → **primary** notes.
2. `handoff.developerLog` (UI field) → **supplement** (appended after the file), or the
   **fallback** when the file is missing or the URL is unparseable.
3. If both are empty, draft a neutral explainer from the enrichment payload alone.

The GitHub fetch never hard-fails the run: a 404, an unparseable URL, or any fetch error
degrades to the UI log (logged, not thrown).

### Mode selection — directive in the notes

The prompt instructs Gemini to:

- Honor an **explicit directive** in the notes if present — either a `mode: explainer` /
  `mode: narrative` line, or natural-language intent (e.g. "write this as a narrative
  about my build").
- Otherwise **infer** the mode from the depth/substance of the notes: rich, detailed
  notes → narrative centered on the demo; thin notes → concise neutral explainer.

The prompt forbids manufactured opinion and filler: criticism/assessment appears only
where the notes or sentiment provide substantive, specific signal.

### Prompt inputs

`state.repo` (name, url, description, stars, language), the enrichment payload
(`documentation`, `sentiment[]`), and the assembled notes. **Excluded:** `seedIdeas`
(brain-dump ideation seeds, not relevant to single-repo coverage).

### Error handling

- Keep the existing guards: missing `enrichment.key` or `handoff` → throw with a clear
  `draftArticle:`-prefixed message.
- Empty or unparseable model output → throw a clear `draftArticle:`-prefixed error so
  Step Functions surfaces/retries it.
- Return shape unchanged: `{ ...state, article }`.

### Infrastructure

- Link `GITHUB_TOKEN` to the `draftArticle` function in `sst.config.ts` (currently
  linked to `GEMINI_API_KEY` + the content payload bucket only). The 60s timeout is
  adequate for a single Pro generation.

## Code shape (isolation + testability)

Following the pure-function style of `parseHandoffEvent` in `publishHandoff.ts`:

**`src/diffpress/lib/devNotes.ts`**
- `parseRepoSlug(url): { owner: string; repo: string } | null` — pure.
- `fetchDevNotes(demoRepoUrl): Promise<string | null>` — the only GitHub call; returns
  `null` on a missing file / bad URL / fetch error.
- `assembleNotes(fileNotes, uiLog): string` — pure; file-primary, UI log appended.

**`src/diffpress/draftArticle.ts`**
- `buildDraftPrompt({ repo, enrichment, notes }): string` — pure.
- `parseDraftResponse(rawText): { title: string; articleMarkdown: string }` — pure.
- A thin `generateContent` wrapper around the Gemini call.
- `handler(state)` — orchestrates: guards → `getPayload` → fetch + assemble notes →
  build prompt → generate → parse → `sanitizeMarkdown` → `{ ...state, article }`.

## Testing (no network)

Unit tests (vitest), mirroring the existing `*.test.ts` files:

- `parseRepoSlug` — valid URLs → `{ owner, repo }`; non-GitHub / malformed → `null`.
- `assembleNotes` — file primary with UI log appended; file-only; UI-only; both empty.
- `buildDraftPrompt` — asserts repo metadata, documentation, sentiment, and notes appear,
  and that the directive-honoring + both-mode instructions are present.
- `parseDraftResponse` — valid JSON → `{ title, articleMarkdown }`; empty / invalid JSON
  / missing fields → throws.

The `generateContent` call and `fetchDevNotes` network path are not exercised in tests.

## Out of scope / follow-ups

- The handoff drawer's "GitHub URL" field pre-fills with the OSS repo URL
  (`card?.repoUrl`); the author overwrites it with the demo URL. Clearing/relabeling that
  prefill is a small UI follow-up, not part of this work.
- A future opinionated-essay article type (macro trends/"vibes", not single-repo) is a
  separate pipeline, out of scope here.
- The `enrichRepos` stub (Exa/Tavily docs + HN/Reddit sentiment) remains a follow-up.
