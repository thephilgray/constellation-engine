# Interest-to-Coverage Scoring — Design

**Date:** 2026-06-17
**Branch:** `diffpress-real-discovery`
**Status:** Design approved; pending spec review → implementation plan
**Builds on:** the GH Archive star-velocity discovery pipeline (`discoverRepos.ts`) and the Gemini drafting handler (`draftArticle.ts`).

## Thesis

The OSINT bet of DiffPress is **High Interest / Low Coverage**: a repo gaining stars
fast (high interest) that nobody has written tutorials/guides about yet (low coverage)
is the most valuable thing to cover. Star velocity already measures interest. This
feature adds the missing half — a **coverage** measurement — and uses it to gate the
discovery board so only under-covered repos surface. As a second payoff, the web-search
results gathered while measuring coverage are **persisted as a source corpus** and fed
into drafting, so an article can review the existing literature and deliberately
differentiate.

## Decisions (locked during brainstorming)

1. **Gate strength: hard filter + re-rank.** Candidates above a coverage threshold are
   dropped entirely (never written to the board); survivors are re-ranked by an
   interest-to-coverage ratio. The board becomes a pure High-Interest/Low-Coverage feed.
2. **Data source: Tavily, general web search.** Search API built for agent use; returns
   ranked results with URLs, relevance scores, and content snippets. ~$0.005/query,
   generous free tier. Searches the whole index (no site whitelist — see rationale
   below); a static `EXCLUDE_DOMAINS` list strips package registries/mirrors. One query
   per candidate for v1.
3. **Query budget: top-40 by velocity.** Only the top 40 quality-passing candidates (by
   star velocity) are scored, bounding Tavily cost to ≤40 queries/run.
4. **Coverage badge: visible, 3-tier.** `coverageScore` is threaded to the board and
   shown as a Low/Med/High chip.
5. **Source persistence: on the ledger row, top-8.** Captured sources are stored as an
   attribute on the DISCOVERED `PublicationRecord` (and on the in-flight
   `RepoCandidate`), not in S3. Bounded (~5–8 KB), survives the human-handoff path, no
   extra fetch at draft time.
6. **Scoring formula: Option A** (breadth + depth, both normalized — see below).
7. **Threshold: fixed constant** in `lib/coverage.ts` for v1 (not a Command Center
   control). Revisit a knob once real runs calibrate the value.
8. **Drafting integration: prompt-only.** `buildDraftPrompt` gains an "existing coverage"
   section; no new I/O in `draftArticle` (sources are read off `state.repo`).

## Architecture & data flow

The feature lives **inside `discoverRepos.ts`**, plus two new lib modules. It slots
between the existing quality filter and the existing lane cap:

```
aggregateSignals → selectForEnrichment → dedupeByExisting
   → GitHub enrich + passesQualityBar            (existing)
   → take top 40 by starsGained                  (NEW: bound Tavily cost)
   → for each: tavily.searchCoverage(repoName)    (NEW: ≤40 queries, bounded concurrency)
   → coverage.scoreCoverage(results, repo)        (NEW: pure)
   → drop if coverageScore > DROP_THRESHOLD       (NEW: hard filter)
   → re-rank by interest/coverage ratio           (NEW)
   → capPerLane(laneBudgets(velocity))            (existing)
   → attach top-8 coverageSources to survivors    (NEW: reuse in-memory results)
   → batchPutDiscovered (now incl. coverageScore + coverageSources)
```

### Module boundaries

- **`lib/tavily.ts`** — the only network/impure part. `searchCoverage(repoName):
  Promise<TavilyResult[]>`. Reads `Resource.TAVILY_API_KEY`. Builds the query, calls
  the Tavily `/search` endpoint with a static `EXCLUDE_DOMAINS` list (see below), maps
  the response to a typed `TavilyResult[]`. Throws on network/HTTP error (caller decides
  policy).
- **`lib/coverage.ts`** — pure, fully unit-testable, no network. Exposes:
  - `buildCoverageQuery(candidate): string` — lane-aware query subject (see below)
  - `scoreCoverage(results: TavilyResult[], repo: { repoName; repoUrl }): CoverageScore`
  - `dropOverCovered(scored, threshold)` — hard filter
  - `rankByInterestToCoverage(scored)` — re-rank
  - `toCoverageSources(results, limit)` — trim to top-N persisted sources
  - named tuning constants: `DOMAIN_SATURATION` (D), `RESULT_SATURATION` (R),
    `RELEVANCE_FLOOR`, `DROP_THRESHOLD`, `BREADTH_WEIGHT`/`DEPTH_WEIGHT`, `SOURCE_LIMIT`.
- **`discoverRepos.handler`** — orchestrates: bounds to top-40, calls Tavily with
  bounded concurrency + per-call timeout, feeds results to the pure scorer, filters,
  re-ranks, lane-caps, attaches sources, writes.

### Concurrency & failure policy (fail-open)

Coverage adds up to 40 network calls to a previously GitHub-only run. Run them with
bounded concurrency (≈5 at a time) and a per-call timeout. **Fail-open:** if a Tavily
call fails or times out, treat that candidate as having *no coverage data* — it is
**retained** (not dropped) with `coverageScore` unset and no `coverageSources`. A flaky
or down Tavily must never empty the board.

## The coverage score (Option A)

**General web search, not a site whitelist.** The breadth half of the score *is* the
count of unique third-party domains; whitelisting a fixed set of tutorial hubs would cap
the very domain-diversity the metric measures, so we search Tavily's whole index. To keep
the result set clean we pass a static **`EXCLUDE_DOMAINS`** list (package registries /
mirrors that are never third-party *coverage*: `npmjs.com`, `pypi.org`, `crates.io`,
`libraries.io`, `github.com`, and similar) on the Tavily request. This complements — does
not replace — the **dynamic per-repo self-domain exclusion** in `lib/coverage.ts` (the
repo's own homepage/docs host, which can only be known per candidate).

**One query per candidate** (v1), holding cost/latency at ≤40 calls/run. The breadth
metric tolerates imperfect recall; a broader or multi-intent query (reviews, comparisons)
is a later refinement, not v1.

**Lane-aware query subject.** *What* we measure coverage of depends on why the candidate
surfaced (`signalType`) — measuring the wrong subject buries the opportunity. A pure
`buildCoverageQuery(candidate)` in `lib/coverage.ts` switches on the lane:

- **RELEASE** → coverage of the *release*, not the repo:
  `"<owner/repo> <releaseTag> release what's new"`. A just-landed release on even a
  hugely popular repo (e.g. `facebook/react v19.2.7`) returns ~0 third-party results →
  `coverageScore ≈ 0` → it surfaces and ranks high, capturing the first-mover window.
  An older release that's already been written up scores high and is dropped. If
  `releaseTag` is missing, fall back to the repo-level query.
- **NEW / TRENDING** → repo-level: `"<owner/repo> tutorial guide getting started"`
  (the project itself is the subject of interest).

`searchCoverage(query)` in `lib/tavily.ts` takes the finished query string, staying a
dumb I/O wrapper; the lane logic is pure and unit-tested.

**Known limitation (out of scope):** the re-rank is `starsGained / coverage`. A mega-repo
gains stars continuously regardless of any release, so a RELEASE candidate with
release-coverage ≈ 0 can rank near the top whenever a big project cuts any tag,
potentially crowding out smaller repos' releases. Refining *interest* for releases
(star-spike attributable to the release vs. baseline) is a separate concern from coverage
and is not addressed here.

Response → `results[]` of `{ url, title, content, score }`. Compute `coverageScore ∈
[0,1]` where **higher = more covered = more likely dropped**.

- **breadth** = `min(uniqueThirdPartyDomains / D, 1)`, `D ≈ 6`.
  - `uniqueThirdPartyDomains` = count of distinct registrable domains across results,
    **excluding self-domains**: `github.com` and the repo's own homepage/docs host
    (derived from `repoUrl` and, where available, the GitHub `homepage`). A project's
    own docs are not third-party coverage.
- **depth** = `min(qualifyingResults / R, 1)`, `R ≈ 5`.
  - a result *qualifies* if its Tavily relevance `score ≥ RELEVANCE_FLOOR` (≈0.5),
    proxying "substantive, on-topic write-up" over incidental mention.
- **`coverageScore = BREADTH_WEIGHT·breadth + DEPTH_WEIGHT·depth`**, with
  `BREADTH_WEIGHT = 0.6`, `DEPTH_WEIGHT = 0.4`.

**Hard filter:** drop candidates with `coverageScore > DROP_THRESHOLD` (≈0.65).

**Re-rank** (survivors): by an interest-to-coverage ratio so under-covered + high-velocity
rise. `rankScore = starsGained / (coverageScore + ε)` (ε small, avoids divide-by-zero
and dampens the score=0 case). Sorted descending. Candidates with no coverage data
(fail-open) sort using `coverageScore = 0` for ranking purposes but carry no badge/sources.

All of `D`, `R`, `RELEVANCE_FLOOR`, `DROP_THRESHOLD`, the weights, and `SOURCE_LIMIT` are
named constants in `lib/coverage.ts`, tuned in code like `STAR_FLOOR`.

## Source corpus & drafting

- New type **`CoverageSource { title; url; domain; abstract; relevanceScore }`** —
  `abstract` is the Tavily `content` snippet, trimmed.
- For each candidate that **survives the gate and is written to the board**, keep the
  top `SOURCE_LIMIT` (≈8) results — already in memory from scoring, so **no extra
  query** — as `coverageSources`, attached to both:
  - the in-flight `RepoCandidate` (→ `ContentEngineState.repo`, the auto-advance path),
  - the DISCOVERED `PublicationRecord` (the board / human-handoff path).
- **`buildDraftPrompt`** (pure, in `draftArticle.ts`) gains a section:
  `## Existing coverage (review the literature, then differentiate)` listing each
  source's title + domain + abstract, with an instruction to orient the article against
  what already exists, reference these where useful, and find an angle the existing
  coverage misses. `coverageSources` is read off `state.repo` — no new I/O in the handler.
- If `coverageSources` is empty/absent (fail-open, or none surfaced), the section renders
  as `(no prior coverage found)` and the model proceeds as today.

## Persistence & types

- **`types.ts`**:
  - add `CoverageSource`.
  - `RepoCandidate`: add optional `coverageScore?: number`, `coverageSources?: CoverageSource[]`.
  - `PublicationRecord`: add optional `coverageScore?: number`, `coverageSources?: CoverageSource[]`.
- **`lib/ledger.ts`**: `toDiscoveredRecord` carries the new fields onto the DISCOVERED
  row; `queryByStatus` projects **`coverageScore`** (for the badge). `coverageSources` is
  read on the single-record/handoff read path used by drafting but is **not** projected
  to the board list (keeps the list payload small). Confirm no DynamoDB reserved-word
  collisions for the new attribute names (none expected; `language` already aliased
  `#lang`).

## UI vertical slice

Mirrors the existing `signalType` threading:

- `PublicationRecord.coverageScore` → ledger `queryByStatus` projection → `listHandoffs`
  response → frontend `RepoCandidate`/board types → `services.ts` mapper → card component.
- Card shows a **3-tier coverage chip** derived from `coverageScore`: Low (<0.33) / Med
  (0.33–0.66) / High (≥0.66). (Survivors sit below `DROP_THRESHOLD≈0.65`, so in practice
  the chip ranges Low–Med; the tiering still communicates gradation.) A card with no
  coverage data (fail-open) shows no chip.
- `coverageSources` is **not** surfaced on the board.

## Infrastructure

- New SST secret **`TAVILY_API_KEY`**, linked to the `discoverRepos` function only.
- **Operator prerequisite:** create a Tavily account + API key and set the secret
  (`npx sst secret set TAVILY_API_KEY …`) before deploy. The plan will flag this.
- No new tables. No change to the Step Functions topology (scoring is inline in
  `discoverRepos`).

## Testing

- **`lib/coverage.test.ts`** (pure): `buildCoverageQuery` — RELEASE uses the release tag,
  NEW/TRENDING use the repo-level phrasing, RELEASE-without-tag falls back to repo-level;
  `scoreCoverage` — breadth saturation, depth via
  relevance floor, self-domain exclusion (github.com + homepage host), empty results;
  `dropOverCovered` boundary at threshold; `rankByInterestToCoverage` ordering incl.
  zero-coverage and no-data cases; `toCoverageSources` top-N trim + field mapping.
- **`discoverRepos.test.ts`**: Tavily wrapper mocked — assert top-40 bound, hard-filter
  drops, re-rank order, `coverageScore`/`coverageSources` attached to written rows, and
  the **fail-open** path (Tavily throws → candidate retained, no badge/sources).
- **`lib/tavily.test.ts`**: response-mapping unit test against a captured fixture
  (network mocked); thin by design.
- **`draftArticle.test.ts`**: `buildDraftPrompt` renders the coverage section from
  `repo.coverageSources`, and renders the `(no prior coverage found)` fallback when empty.
- Gates: full vitest suite green, `tsc --noEmit` clean, `npm run build` passes.

## Out of scope

- The `enrichRepos.ts` stub (deep per-repo documentation/sentiment enrichment of the
  single selected repo) is a separate concern and stays stubbed; this feature does not
  replace it.
- Making the coverage threshold a Command Center control (deferred until real runs
  calibrate the value).
- HN/Reddit sentiment sourcing.

## Cold-start note

Coverage scoring depends only on Tavily (live web search), not on the GH Archive
velocity window, so it has no additional warm-up beyond what discovery already requires.
The existing cold-start caveat (the 7-day velocity window must fill before `discoverRepos`
yields candidates) is unchanged.
