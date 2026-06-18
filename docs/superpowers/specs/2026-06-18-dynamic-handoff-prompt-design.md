# Dynamic LLM-Generated Handoff Prompts — Design

**Date:** 2026-06-18
**Module:** DiffPress (Content Engine)
**Status:** Approved design, pending implementation plan

## Problem

When a repo reaches the "Ready for Dev" column, the handoff prompt the user
reads (the brief telling them what demo project to build with the selected
repo, and how to log the experience) is **hardcoded boilerplate**, synthesized
client-side in `src/components/diffpress/store.ts` (`buildHandoffPrompt`). It
reads "Clone the repository and run it locally as a critical reviewer" for
every repo, ignoring all the context the pipeline has already gathered.

We want the prompt to be **dynamic and LLM-generated**, taking into account:

- Demo-project seed ideas from the brain-dump Pinecone index, or LLM-invented
  ideas when seeds don't fit.
- Information about the repo and what it's for (description + real README).
- Existing web coverage (Tavily) — so the proposed demo differentiates from
  what's already been written about the repo.

The generated prompt should brief the user to build **one original,
non-trivial demo project** featuring the selected repo (never hello-world /
trivial), and guide LLM-driven logging of the build so the dev log becomes the
first draft of a **narrative, demo-centric article** that features the repo —
including specific repo details and a critical-evaluation section near the end.
When the repo is a poor fit for any real demo idea, fall back to a lighter
**explainer** format (clone, run, critically evaluate).

## Current State (what already exists)

The pipeline (`sst.config.ts` state machine) is:

```
DiscoverRepos → EnrichRepos → SeedIdeas → AwaitHandoff(token) → DraftArticle → RecordPublication
```

- **`discoverRepos.ts`** already calls the GitHub API per candidate, but only
  for **metadata** (`octokit.rest.repos.get`: description, language, topics,
  license, stars, archived). It does **not** fetch the README. Nothing in the
  codebase fetches a README today.
- **`enrichRepos.ts`** is a **stub**: `gatherEnrichment()` sets
  `documentation` to `"# {repo}\n\n{description}\n\n(stub documentation)"` and a
  stub sentiment entry. It runs on the **single selected repo** only (by this
  step `state.repo` is the one winner), so any GitHub call added here is one
  call per pipeline run, not per candidate.
- **`seedIdeas.ts`** already queries the `brain-dump` Pinecone index (top-5)
  with an LLM-stub fallback, returning `state.seedIdeas`.
- **`coverageSources`** (Tavily) already ride on `state.repo` from discovery.
- **`draftArticle.ts`** already runs Gemini (`gemini-2.5-pro`, structured
  output via `responseSchema`) and already supports an explainer/narrative
  `mode`, today inferred from the dev-log notes (and honoring an explicit
  `mode:` directive in the notes).
- Persistence path for the board: `notifyHandoff` →
  `markAwaitingHandoff(repoName, {...})` (ledger record) →
  `listHandoffs.bucketBoard` → `readyForDev` `HandoffItem` → frontend
  `openDrawer` builds the card → `buildHandoffPrompt` boilerplate.

**The only gap is the generator.** All inputs (README-once-fetched, seed ideas,
coverage) and the downstream consumer (`draftArticle`'s mode) already exist.

## Approach

Insert one new Lambda step, **`GenerateHandoff`**, between `SeedIdeas` and
`AwaitHandoff`. Upgrade the `enrichRepos` stub to fetch the real README (one
call, selected repo only). Thread the generated prompt through the existing
ledger → board → drawer path via a new `handoffPrompt` field, replacing the
hardcoded boilerplate (kept only as a fallback).

```
DiscoverRepos → EnrichRepos(+README) → SeedIdeas(brain-dump)
  → GenerateHandoff(Gemini) → AwaitHandoff(persist prompt+mode)
  → [user builds + logs] → resume → DraftArticle(honors mode) → RecordPublication
```

### Design decisions (resolved)

1. **Repo grounding — fix the `enrichRepos` stub.** Discovery stays lean (no
   README fetch per candidate; the quality bar + Tavily coverage already gate
   candidates). The README is fetched **once, for the winner**, in
   `enrichRepos` — its natural home, since it's literally a stubbed
   "fetch documentation" step. `GenerateHandoff` and `draftArticle` both
   consume `enrichment.documentation`, so the article grounding improves for
   free with no duplicate fetch.
2. **Idea sourcing — blend as loose inspiration (for now).** Seed ideas are fed
   to Gemini as inspiration; it freely synthesizes the single best original
   demo idea for the repo, leaning on a seed when one fits. The eventual target
   is "brain-dump first, LLM fallback," but the brain-dump seeds aren't
   reliable yet and the seeding scheme is subject to change — so the seed-idea
   coupling is kept **loose** and easy to tighten later.
3. **Mode authority — `GenerateHandoff` decides, persisted in state.**
   `GenerateHandoff` owns the fit + idea + mode decision and writes `mode` into
   `ContentEngineState`. It survives the wait-for-token pause (the `AwaitHandoff`
   output merges pre-pause state). `draftArticle` **prefers `state.mode`** when
   present, else keeps today's infer-from-notes behavior. Robust — does not rely
   on the user carrying a directive through their dev log.
4. **Model — `gemini-2.5-pro`**, matching `draftArticle`, for idea quality.

## Components

1. **`src/diffpress/enrichRepos.ts`** — replace the `documentation` stub with a
   real README fetch via `octokit.rest.repos.getReadme(owner, repo)`,
   base64-decode the content, truncate to a sane cap (~8 KB). On 404 / empty
   README, proceed with description-only documentation (logged). Leave the
   `sentiment` stub unchanged (out of scope).

2. **`src/diffpress/generateHandoff.ts`** (new):
   - **`buildMetaPrompt(input)`** — pure. Assembles the Gemini instruction from
     repo metadata, `enrichment.documentation` (README), `coverageSources`, and
     `seedIdeas`. Handles empty cases (no seeds, no coverage, no README).
   - **`handler(state)`** — loads the enrichment payload, calls Gemini
     (`gemini-2.5-pro`) with **structured output**
     `{ mode: "narrative" | "explainer", handoffMarkdown: string }`, and returns
     `{ ...state, mode, handoffPrompt }`. On Gemini failure, fall back to a
     boilerplate prompt and leave `mode` unset so the pipeline never stalls.
   - Lazy-init the `GoogleGenAI` client (as `draftArticle` does) so unit tests
     don't need SST Resource bindings.

3. **`src/diffpress/notifyHandoff.ts` + `src/diffpress/lib/ledger.ts`** — thread
   `handoffPrompt` into `markAwaitingHandoff` and persist it on the
   `AWAITING_HANDOFF` record (`buildMarkAwaitingParams`).

4. **`src/diffpress/types.ts`** — add `mode?: "narrative" | "explainer"` and
   `handoffPrompt?: string` to `ContentEngineState`; add `handoffPrompt?: string`
   to `PublicationRecord`.

5. **`src/diffpress/listHandoffs.ts`** — add `handoffPrompt` to `HandoffItem`
   and project it in `bucketBoard` for the `AWAITING_HANDOFF` case.

6. **`src/diffpress/draftArticle.ts`** — prefer `state.mode` when present
   (pass it explicitly into the draft prompt / mode resolution), else keep the
   current infer-from-notes behavior.

7. **`sst.config.ts`** — new `GenerateHandoff` `sst.aws.Function` linked to
   `GEMINI_API_KEY`; link `GITHUB_TOKEN` to `enrichRepos` (for the README
   fetch). Add the `generateHandoffState` `lambdaInvoke` and splice it between
   `seedState` and `awaitHandoffState` in the chain.

8. **Frontend — `src/components/diffpress/store.ts`, `types.ts`,
   `services.ts`** — `HandoffItem`/card type carry `handoffPrompt`; `openDrawer`
   uses `card.handoffPrompt ?? buildHandoffPrompt(card.repo)`. Keep
   `buildHandoffPrompt` as the fallback for older records / generation failures.

## The Meta-Prompt

`buildMetaPrompt` instructs Gemini to:

- **Judge fit first.** Given repo description + README + language + existing
  coverage, decide whether this repo is a good basis for an original,
  non-trivial demo project.
- **If a good fit → `mode: narrative`.** Propose **one specific, real** demo
  project (explicitly not hello-world / trivial) that uses the repo
  meaningfully, **loosely inspired** by the seed ideas, and **differentiated
  from existing coverage**. The handoff brief covers: what to build & why it's
  interesting; which repo features/APIs to exercise; and **logging guidance** —
  capture decisions, friction points, timings, specific repo details, and a
  **critical-evaluation section near the end**.
- **If a poor fit → `mode: explainer`.** A lighter "clone, run, critically
  evaluate" brief.
- **Both modes** frame the dev log as the first draft of a **narrative,
  demo-centric article** featuring the repo as its subject — what `draftArticle`
  then expands.
- **Logging location (both modes).** The prompt must instruct the builder to
  create a **`DIFFPRESS.md` file at the root of the demo project repo** and log
  there. This is the existing convention: `draftArticle` reads `DIFFPRESS.md`
  from the demo repo root via `fetchDevNotes` (`NOTES_FILENAME = "DIFFPRESS.md"`)
  as the primary source, falling back to the UI handoff log. No backend change
  is needed for this — only the generated prompt must name the file and direct
  logging there.

`GenerateHandoff` owns the fit + idea + mode decision; `draftArticle` consumes
the resulting `mode`.

## Error Handling

- **README missing / 404 / empty** → description-only grounding (logged); the
  generator still runs.
- **Gemini failure** → persist the boilerplate prompt, leave `mode` unset
  (`draftArticle` infers from notes as today). The pipeline never blocks on the
  LLM.
- **README truncation** at ~8 KB to bound prompt size and cost.

## Testing (TDD)

- **`enrichRepos`** — README base64 decode + truncate; 404 / empty README
  fallback (mock `octokit`).
- **`generateHandoff`** — pure `buildMetaPrompt` assembly: seed/coverage/README
  formatting and empty cases (no seeds, no coverage, no README); `handler` mode
  propagation into returned state and the Gemini-failure → boilerplate fallback
  (mock `GoogleGenAI`). Respect the vitest `mockReset`/`beforeEach` gotcha (use a
  block-body `beforeEach`, never an expression-arrow returning a `Mock`).
- **`ledger`** — `buildMarkAwaitingParams` persists `handoffPrompt`.
- **`listHandoffs`** — `bucketBoard` surfaces `handoffPrompt` on `readyForDev`.

## Out of Scope

- Making the `sentiment` enrichment real (still a stub).
- Tightening seed sourcing to "brain-dump first" (option 1) — deferred until the
  brain-dump seeding scheme stabilizes.
- Using README content to filter candidates during discovery.
