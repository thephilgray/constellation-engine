# Interest-to-Coverage Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate the DiffPress discovery board to High-Interest/Low-Coverage repos by scoring each candidate's existing web coverage (via Tavily), dropping over-covered ones, re-ranking survivors, and persisting the gathered sources to feed drafting.

**Architecture:** Coverage scoring runs inline in `discoverRepos.ts`, between the existing quality filter and lane cap. A pure `lib/coverage.ts` (lane-aware query, scoring, filter, re-rank, source trim) is fed by a thin I/O wrapper `lib/tavily.ts`. The score surfaces as a board badge; the top sources persist on the DISCOVERED ledger row and on the in-flight `RepoCandidate`, and `draftArticle`'s prompt cites them. Fail-open: a Tavily error retains the candidate unscored.

**Tech Stack:** TypeScript, AWS Lambda (Node 20), DynamoDB (single-table ledger), SST v3, Tavily Search API (via global `fetch`), Vitest, React/Astro frontend.

---

## File Structure

**Create:**
- `src/diffpress/lib/coverage.ts` — pure scoring: `buildCoverageQuery`, `scoreCoverage`, `dropOverCovered`, `rankByInterestToCoverage`, `toCoverageSources`, tuning constants.
- `src/diffpress/lib/coverage.test.ts` — unit tests for the above.
- `src/diffpress/lib/tavily.ts` — I/O wrapper: `searchCoverage(query)`, `TavilyResult`, `EXCLUDE_DOMAINS`, response mapping.
- `src/diffpress/lib/tavily.test.ts` — response-mapping unit test (fetch mocked).

**Modify:**
- `src/diffpress/types.ts` — add `CoverageSource`; extend `RepoCandidate` and `PublicationRecord`.
- `src/diffpress/discoverRepos.ts` — integrate scoring pipeline; carry new fields in `toDiscoveredRecord`.
- `src/diffpress/discoverRepos.test.ts` — top-40 bound, hard filter, re-rank, source attach, fail-open.
- `src/diffpress/lib/ledger.ts:205-207` — project `coverageScore` in `queryByStatus`.
- `src/diffpress/listHandoffs.ts` — add `coverageScore` to `DiscoveredItem` + `bucketBoard`.
- `src/diffpress/draftArticle.ts:26-69` — render coverage section in `buildDraftPrompt`.
- `src/diffpress/draftArticle.test.ts` — coverage-section render + empty fallback.
- `src/components/diffpress/types.ts` — add `coverageScore` to `DiscoveryCard` and the handoff `discovered` item type.
- `src/components/diffpress/services.ts:30-42` — map `coverageScore`.
- `src/components/diffpress/Dashboard.tsx` — 3-tier coverage chip.
- `sst.config.ts` — `TAVILY_API_KEY` secret + link to `discoverRepos`.

---

## Task 1: Domain types for coverage

**Files:**
- Modify: `src/diffpress/types.ts`

- [ ] **Step 1: Add the `CoverageSource` type and extend candidate/record**

In `src/diffpress/types.ts`, add after the `RepoCandidate` interface (after line 23, before `EnrichmentPayload`):

```typescript
/** A third-party web source about a repo (or a specific release), from Tavily. */
export interface CoverageSource {
  title: string;
  url: string;
  domain: string; // registrable domain, e.g. "dev.to"
  abstract: string; // trimmed Tavily content snippet
  relevanceScore: number; // Tavily relevance score, 0..1
}
```

Then add these two optional fields inside `RepoCandidate` (after `releaseTag?: string;` on line 22):

```typescript
  // Interest-to-Coverage (set by discoverRepos via Tavily).
  coverageScore?: number; // 0..1, higher = more existing coverage
  coverageSources?: CoverageSource[]; // top sources, persisted for drafting
```

And add the same two fields inside `PublicationRecord` (after `releaseTag?: string;` on line 98):

```typescript
  coverageScore?: number; // 0..1; projected to the board badge
  coverageSources?: CoverageSource[]; // top sources (not projected to board list)
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Commit**

```bash
git add src/diffpress/types.ts
git commit -m "feat(diffpress): coverage types — CoverageSource + candidate/record fields"
```

---

## Task 2: Pure coverage module — query, scoring, filter, re-rank, source trim

**Files:**
- Create: `src/diffpress/lib/coverage.ts`
- Test: `src/diffpress/lib/coverage.test.ts`

This module is pure (no network, no SST). It depends only on `TavilyResult` (defined in Task 3) and the types from Task 1. To avoid a circular dependency, `TavilyResult` is imported as a type only.

- [ ] **Step 1: Write the failing tests**

Create `src/diffpress/lib/coverage.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  buildCoverageQuery,
  scoreCoverage,
  dropOverCovered,
  rankByInterestToCoverage,
  toCoverageSources,
  DROP_THRESHOLD,
} from "./coverage";
import type { RepoCandidate } from "../types";
import type { TavilyResult } from "./tavily";

function candidate(over: Partial<RepoCandidate> = {}): RepoCandidate {
  return {
    repoName: "acme/widget",
    repoUrl: "https://github.com/acme/widget",
    description: "A widget",
    stars: 1000,
    language: "TypeScript",
    pushedAt: "2026-06-10T00:00:00Z",
    signalType: "TRENDING",
    starsGained: 200,
    ...over,
  };
}

function result(url: string, score = 0.8, title = "T", content = "C"): TavilyResult {
  return { title, url, content, score };
}

describe("buildCoverageQuery", () => {
  it("uses the release tag for RELEASE candidates", () => {
    const q = buildCoverageQuery(
      candidate({ signalType: "RELEASE", releaseTag: "v19.2.7" })
    );
    expect(q).toContain("acme/widget");
    expect(q).toContain("v19.2.7");
  });

  it("uses repo-level phrasing for NEW/TRENDING", () => {
    expect(buildCoverageQuery(candidate({ signalType: "TRENDING" }))).toBe(
      "acme/widget tutorial guide getting started"
    );
    expect(buildCoverageQuery(candidate({ signalType: "NEW" }))).toBe(
      "acme/widget tutorial guide getting started"
    );
  });

  it("falls back to repo-level when RELEASE has no tag", () => {
    expect(
      buildCoverageQuery(candidate({ signalType: "RELEASE", releaseTag: undefined }))
    ).toBe("acme/widget tutorial guide getting started");
  });
});

describe("scoreCoverage", () => {
  const repo = { repoName: "acme/widget", repoUrl: "https://github.com/acme/widget" };

  it("returns 0 for no results", () => {
    expect(scoreCoverage([], repo).coverageScore).toBe(0);
  });

  it("excludes self and registry domains from breadth", () => {
    const results = [
      result("https://github.com/acme/widget"),
      result("https://npmjs.com/package/widget"),
      result("https://acme.dev/widget"), // self homepage host is repoUrl-derived; acme.dev is third-party here
    ];
    // github.com excluded (self/registry); npmjs handled at query time but also guard here.
    const score = scoreCoverage(results, repo);
    expect(score.coverageScore).toBeGreaterThan(0);
    expect(score.coverageScore).toBeLessThan(1);
  });

  it("saturates breadth at >= 6 distinct third-party domains", () => {
    const results = [
      "a.com", "b.com", "c.com", "d.com", "e.com", "f.com", "g.com",
    ].map((d) => result(`https://${d}/post`));
    const score = scoreCoverage(results, repo);
    // breadth fully saturated (1.0); depth from 7 qualifying results also saturates (1.0)
    expect(score.coverageScore).toBeCloseTo(1, 5);
  });

  it("depth counts only results above the relevance floor", () => {
    const results = [
      result("https://a.com/x", 0.9),
      result("https://b.com/x", 0.2), // below floor → not a qualifying result
    ];
    const score = scoreCoverage(results, repo);
    // 2 distinct domains breadth, but only 1 qualifying depth result
    expect(score.coverageScore).toBeGreaterThan(0);
  });
});

describe("dropOverCovered", () => {
  it("drops candidates strictly above the threshold, keeps the rest", () => {
    const c1 = candidate({ repoName: "a/1", coverageScore: DROP_THRESHOLD + 0.1 });
    const c2 = candidate({ repoName: "a/2", coverageScore: DROP_THRESHOLD });
    const c3 = candidate({ repoName: "a/3", coverageScore: 0.1 });
    const kept = dropOverCovered([c1, c2, c3]);
    expect(kept.map((c) => c.repoName)).toEqual(["a/2", "a/3"]);
  });

  it("keeps candidates with no coverageScore (fail-open)", () => {
    const c = candidate({ repoName: "a/9", coverageScore: undefined });
    expect(dropOverCovered([c])).toHaveLength(1);
  });
});

describe("rankByInterestToCoverage", () => {
  it("ranks high-velocity / low-coverage first", () => {
    const a = candidate({ repoName: "a", starsGained: 100, coverageScore: 0.5 });
    const b = candidate({ repoName: "b", starsGained: 100, coverageScore: 0.05 });
    const ranked = rankByInterestToCoverage([a, b]);
    expect(ranked[0].repoName).toBe("b");
  });

  it("treats missing coverageScore as 0 (ranks high)", () => {
    const a = candidate({ repoName: "a", starsGained: 100, coverageScore: 0.5 });
    const b = candidate({ repoName: "b", starsGained: 100, coverageScore: undefined });
    const ranked = rankByInterestToCoverage([a, b]);
    expect(ranked[0].repoName).toBe("b");
  });
});

describe("toCoverageSources", () => {
  it("trims to the top N and maps fields incl. domain", () => {
    const results = Array.from({ length: 12 }, (_, i) =>
      result(`https://site${i}.com/p`, 0.9 - i * 0.01, `Title ${i}`, `Body ${i}`)
    );
    const sources = toCoverageSources(results, 8);
    expect(sources).toHaveLength(8);
    expect(sources[0]).toEqual({
      title: "Title 0",
      url: "https://site0.com/p",
      domain: "site0.com",
      abstract: "Body 0",
      relevanceScore: 0.9,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/diffpress/lib/coverage.test.ts`
Expected: FAIL — `Cannot find module './coverage'`.

- [ ] **Step 3: Implement `lib/coverage.ts`**

Create `src/diffpress/lib/coverage.ts`:

```typescript
// Pure Interest-to-Coverage scoring. No network, no SST bindings.
import type { RepoCandidate, CoverageSource } from "../types";
import type { TavilyResult } from "./tavily";

// --- Tuning constants (calibrate after real runs, like STAR_FLOOR) ---
/** Distinct third-party domains at which breadth saturates to 1.0. */
export const DOMAIN_SATURATION = 6;
/** Qualifying results at which depth saturates to 1.0. */
export const RESULT_SATURATION = 5;
/** A result counts toward depth only if its relevance score >= this. */
export const RELEVANCE_FLOOR = 0.5;
/** Candidates with coverageScore strictly above this are dropped. */
export const DROP_THRESHOLD = 0.65;
export const BREADTH_WEIGHT = 0.6;
export const DEPTH_WEIGHT = 0.4;
/** How many sources to persist per surfaced candidate. */
export const SOURCE_LIMIT = 8;
/** Small epsilon so zero-coverage doesn't divide by zero in the re-rank. */
const RANK_EPSILON = 0.01;

export interface CoverageScore {
  coverageScore: number; // 0..1
}

/** Pure: the lane-aware Tavily query subject for a candidate. */
export function buildCoverageQuery(candidate: RepoCandidate): string {
  if (candidate.signalType === "RELEASE" && candidate.releaseTag) {
    return `${candidate.repoName} ${candidate.releaseTag} release what's new`;
  }
  return `${candidate.repoName} tutorial guide getting started`;
}

/** Extract the registrable-ish domain (host minus leading www.) from a URL. */
export function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Pure: score how much third-party coverage exists. Higher = more covered.
 * Excludes the repo's own host and github.com from the breadth count (a
 * project's own docs are not third-party coverage). Registry domains are
 * stripped at query time in tavily.ts; github.com is guarded here too.
 */
export function scoreCoverage(
  results: TavilyResult[],
  repo: { repoName: string; repoUrl: string }
): CoverageScore {
  const selfHost = domainOf(repo.repoUrl);
  const excluded = new Set<string>(["github.com"]);
  if (selfHost) excluded.add(selfHost);

  const domains = new Set<string>();
  let qualifying = 0;
  for (const r of results) {
    const d = domainOf(r.url);
    if (!d || excluded.has(d)) continue;
    domains.add(d);
    if (r.score >= RELEVANCE_FLOOR) qualifying++;
  }

  const breadth = Math.min(domains.size / DOMAIN_SATURATION, 1);
  const depth = Math.min(qualifying / RESULT_SATURATION, 1);
  const coverageScore = BREADTH_WEIGHT * breadth + DEPTH_WEIGHT * depth;
  return { coverageScore };
}

/** Pure: drop candidates whose coverageScore exceeds the threshold. Unscored kept. */
export function dropOverCovered(
  candidates: RepoCandidate[],
  threshold: number = DROP_THRESHOLD
): RepoCandidate[] {
  return candidates.filter(
    (c) => c.coverageScore === undefined || c.coverageScore <= threshold
  );
}

/** Pure: rank by interest-to-coverage ratio, descending. Missing score => 0. */
export function rankByInterestToCoverage(
  candidates: RepoCandidate[]
): RepoCandidate[] {
  const ratio = (c: RepoCandidate) =>
    (c.starsGained ?? 0) / ((c.coverageScore ?? 0) + RANK_EPSILON);
  return [...candidates].sort((a, b) => ratio(b) - ratio(a));
}

/** Pure: top-N results mapped to persisted CoverageSource records. */
export function toCoverageSources(
  results: TavilyResult[],
  limit: number = SOURCE_LIMIT
): CoverageSource[] {
  const out: CoverageSource[] = [];
  for (const r of results) {
    const domain = domainOf(r.url);
    if (!domain) continue;
    out.push({
      title: r.title,
      url: r.url,
      domain,
      abstract: r.content,
      relevanceScore: r.score,
    });
    if (out.length >= limit) break;
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/diffpress/lib/coverage.test.ts`
Expected: PASS (all cases).

> Note: `coverage.test.ts` imports `TavilyResult` from `./tavily` as a type. Since `lib/tavily.ts` does not exist yet, create a minimal type-only stub first if running this task in isolation, OR run Task 3 before executing this task's tests. Recommended order: do Task 3's type definition step, then this task. (Type-only imports are erased at compile, but the file must resolve.)

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/lib/coverage.ts src/diffpress/lib/coverage.test.ts
git commit -m "feat(diffpress): pure coverage scoring — query, score, filter, re-rank, sources"
```

---

## Task 3: Tavily I/O wrapper

**Files:**
- Create: `src/diffpress/lib/tavily.ts`
- Test: `src/diffpress/lib/tavily.test.ts`

Uses global `fetch` (Lambda Node 20). No SDK dependency.

- [ ] **Step 1: Write the failing test**

Create `src/diffpress/lib/tavily.test.ts`:

```typescript
import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the SST Resource so importing the module needs no real binding.
vi.mock("sst", () => ({
  Resource: { TAVILY_API_KEY: { value: "test-key" } },
}));

import { mapTavilyResponse, EXCLUDE_DOMAINS } from "./tavily";

afterEach(() => vi.restoreAllMocks());

describe("mapTavilyResponse", () => {
  it("maps results to typed TavilyResult[], dropping malformed entries", () => {
    const raw = {
      results: [
        { title: "Guide", url: "https://dev.to/x", content: "body", score: 0.91 },
        { title: "No url", content: "x", score: 0.5 }, // dropped (no url)
        { url: "https://b.com", content: "y", score: 0.3 }, // title defaults to ""
      ],
    };
    const mapped = mapTavilyResponse(raw);
    expect(mapped).toEqual([
      { title: "Guide", url: "https://dev.to/x", content: "body", score: 0.91 },
      { title: "", url: "https://b.com", content: "y", score: 0.3 },
    ]);
  });

  it("returns [] when results is missing", () => {
    expect(mapTavilyResponse({})).toEqual([]);
  });

  it("excludes registry/mirror domains by default", () => {
    expect(EXCLUDE_DOMAINS).toContain("npmjs.com");
    expect(EXCLUDE_DOMAINS).toContain("github.com");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/lib/tavily.test.ts`
Expected: FAIL — `Cannot find module './tavily'`.

- [ ] **Step 3: Implement `lib/tavily.ts`**

Create `src/diffpress/lib/tavily.ts`:

```typescript
// Thin I/O wrapper around the Tavily Search API. The only network/impure part
// of coverage scoring. Lane/scoring logic lives in lib/coverage.ts.
import { Resource } from "sst";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
/** Max results requested per query (enough to count breadth + fill sources). */
const MAX_RESULTS = 10;

// Read the key lazily through an unknown cast: SST only adds TAVILY_API_KEY to
// the Resource types after a deploy/dev regenerates sst-env.d.ts, so this keeps
// `tsc --noEmit` green beforehand. See [[sst-typegen-gotchas]].
function apiKey(): string {
  return (Resource as unknown as { TAVILY_API_KEY: { value: string } })
    .TAVILY_API_KEY.value;
}

/** Registry / mirror domains that are never third-party coverage. */
export const EXCLUDE_DOMAINS = [
  "github.com",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "libraries.io",
  "packagist.org",
  "rubygems.org",
];

/** One normalized Tavily search result. */
export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

/** Pure: map a raw Tavily response body to typed results, dropping bad rows. */
export function mapTavilyResponse(body: unknown): TavilyResult[] {
  const results = (body as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: TavilyResult[] = [];
  for (const r of results) {
    const row = r as Record<string, unknown>;
    if (typeof row.url !== "string") continue;
    out.push({
      title: typeof row.title === "string" ? row.title : "",
      url: row.url,
      content: typeof row.content === "string" ? row.content : "",
      score: typeof row.score === "number" ? row.score : 0,
    });
  }
  return out;
}

/**
 * Run one general web search for the given query. Throws on network/HTTP error
 * (the caller in discoverRepos applies the fail-open policy).
 */
export async function searchCoverage(query: string): Promise<TavilyResult[]> {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      query,
      max_results: MAX_RESULTS,
      exclude_domains: EXCLUDE_DOMAINS,
      search_depth: "basic",
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
  }
  return mapTavilyResponse(await res.json());
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/lib/tavily.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run Task 2 tests now that `./tavily` resolves**

Run: `npx vitest run src/diffpress/lib/coverage.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/lib/tavily.ts src/diffpress/lib/tavily.test.ts
git commit -m "feat(diffpress): Tavily search wrapper with registry exclusion"
```

---

## Task 4: Integrate coverage scoring into discoverRepos

**Files:**
- Modify: `src/diffpress/discoverRepos.ts`
- Test: `src/diffpress/discoverRepos.test.ts`

The new flow inserts, after the existing quality-filtered `enriched[]` is built and before the lane cap: take top-40 by velocity → Tavily-score with bounded concurrency (fail-open) → drop over-covered → re-rank → (then existing lane cap) → attach sources to survivors. `toDiscoveredRecord` must carry the new fields (it spreads candidate fields explicitly, so add them).

- [ ] **Step 1: Write the failing tests**

Add to `src/diffpress/discoverRepos.test.ts` (append a new describe block; keep existing tests). At the top of the file ensure these mocks exist — if the file already mocks `./lib/signals`, `./lib/ledger`, and `@octokit/rest`, add a mock for `./lib/tavily`:

```typescript
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./lib/tavily", () => ({
  searchCoverage: vi.fn(),
  EXCLUDE_DOMAINS: [],
}));

import { scoreAndGateCandidates } from "./discoverRepos";
import { searchCoverage } from "./lib/tavily";
import type { RepoCandidate } from "./types";

function cand(over: Partial<RepoCandidate> = {}): RepoCandidate {
  return {
    repoName: "acme/widget",
    repoUrl: "https://github.com/acme/widget",
    description: "d",
    stars: 100,
    language: "TS",
    pushedAt: "2026-06-10T00:00:00Z",
    signalType: "TRENDING",
    starsGained: 100,
    ...over,
  };
}

describe("scoreAndGateCandidates", () => {
  beforeEach(() => vi.mocked(searchCoverage).mockReset());

  it("scores at most the top 40 by starsGained", async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      cand({ repoName: `a/${i}`, starsGained: i })
    );
    vi.mocked(searchCoverage).mockResolvedValue([]);
    await scoreAndGateCandidates(many);
    expect(vi.mocked(searchCoverage)).toHaveBeenCalledTimes(40);
  });

  it("drops over-covered candidates and attaches score + sources to survivors", async () => {
    const lo = cand({ repoName: "a/lo", starsGained: 10 });
    const hi = cand({ repoName: "a/hi", starsGained: 10 });
    vi.mocked(searchCoverage).mockImplementation(async (q: string) => {
      if (q.includes("a/hi")) {
        // saturate coverage → dropped
        return ["x.com","y.com","z.com","p.com","q.com","r.com"].map((d) => ({
          title: "t", url: `https://${d}/a`, content: "c", score: 0.9,
        }));
      }
      return [{ title: "t", url: "https://only.com/a", content: "c", score: 0.9 }];
    });
    const out = await scoreAndGateCandidates([lo, hi]);
    expect(out.map((c) => c.repoName)).toEqual(["a/lo"]);
    expect(out[0].coverageScore).toBeGreaterThan(0);
    expect(out[0].coverageSources?.[0].domain).toBe("only.com");
  });

  it("fails open: a Tavily error retains the candidate, unscored", async () => {
    vi.mocked(searchCoverage).mockRejectedValue(new Error("503"));
    const out = await scoreAndGateCandidates([cand({ repoName: "a/x" })]);
    expect(out).toHaveLength(1);
    expect(out[0].coverageScore).toBeUndefined();
    expect(out[0].coverageSources).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/diffpress/discoverRepos.test.ts -t scoreAndGateCandidates`
Expected: FAIL — `scoreAndGateCandidates` is not exported.

- [ ] **Step 3: Implement the scoring stage in `discoverRepos.ts`**

Add imports near the top of `src/diffpress/discoverRepos.ts` (after the existing `./lib/config` import):

```typescript
import { searchCoverage } from "./lib/tavily";
import {
  buildCoverageQuery,
  scoreCoverage,
  dropOverCovered,
  rankByInterestToCoverage,
  toCoverageSources,
} from "./lib/coverage";
```

Add these constants near the other `const` declarations (after `RELEASE_ENRICH_LIMIT`):

```typescript
/** Max candidates to spend Tavily queries on per run (bounds cost). */
const COVERAGE_SCORE_LIMIT = 40;
/** How many Tavily calls run concurrently. */
const COVERAGE_CONCURRENCY = 5;
```

Add this exported function (place it above `handler`):

```typescript
/**
 * Score the top candidates' existing web coverage (Tavily), drop the
 * over-covered ones, re-rank survivors by interest-to-coverage, and attach the
 * top sources for drafting. Fail-open: a Tavily error retains the candidate
 * unscored (a flaky/down API must never empty the board).
 */
export async function scoreAndGateCandidates(
  enriched: RepoCandidate[]
): Promise<RepoCandidate[]> {
  const toScore = [...enriched]
    .sort((a, b) => (b.starsGained ?? 0) - (a.starsGained ?? 0))
    .slice(0, COVERAGE_SCORE_LIMIT);

  // Bounded-concurrency scoring; mutate copies, never the inputs.
  const scored: RepoCandidate[] = [];
  for (let i = 0; i < toScore.length; i += COVERAGE_CONCURRENCY) {
    const batch = toScore.slice(i, i + COVERAGE_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (c) => {
        try {
          const hits = await searchCoverage(buildCoverageQuery(c));
          const { coverageScore } = scoreCoverage(hits, {
            repoName: c.repoName,
            repoUrl: c.repoUrl,
          });
          return { ...c, coverageScore, coverageSources: toCoverageSources(hits) };
        } catch (err) {
          console.warn(`[discoverRepos] coverage scoring failed for ${c.repoName}; retaining unscored`, err);
          return { ...c }; // fail-open: no score, no sources
        }
      })
    );
    scored.push(...results);
  }

  return rankByInterestToCoverage(dropOverCovered(scored));
}
```

Now wire it into `handler`. Replace the block that currently reads (around lines 236–244):

```typescript
  if (enriched.length === 0) {
    throw new Error("No quality discovery candidates this cycle.");
  }

  // 4. Apply Command Center config: keep only the active lanes for the current
  //    mode, capped to the per-lane budget derived from velocity.
  const cfg = await getDiscoveryConfig();
```

with:

```typescript
  if (enriched.length === 0) {
    throw new Error("No quality discovery candidates this cycle.");
  }

  // 4. Score existing web coverage; drop over-covered, re-rank by interest/coverage.
  const gated = await scoreAndGateCandidates(enriched);
  if (gated.length === 0) {
    throw new Error("No under-covered discovery candidates this cycle.");
  }

  // 5. Apply Command Center config: keep only the active lanes for the current
  //    mode, capped to the per-lane budget derived from velocity.
  const cfg = await getDiscoveryConfig();
```

Then change the lane-cap line that consumes `enriched` to consume `gated`. Find:

```typescript
  const laned = capPerLane(enriched, laneBudgets(cfg.velocity, lanes));
```

and replace with:

```typescript
  const laned = capPerLane(gated, laneBudgets(cfg.velocity, lanes));
```

- [ ] **Step 4: Carry the new fields in `toDiscoveredRecord`**

In `toDiscoveredRecord` (around lines 149–167), add the two fields to the returned record, after `releaseTag: c.releaseTag,`:

```typescript
    coverageScore: c.coverageScore,
    coverageSources: c.coverageSources,
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run src/diffpress/discoverRepos.test.ts -t scoreAndGateCandidates`
Expected: PASS.

- [ ] **Step 6: Run the whole discoverRepos suite (no regressions)**

Run: `npx vitest run src/diffpress/discoverRepos.test.ts`
Expected: PASS (existing tests still green).

- [ ] **Step 7: Commit**

```bash
git add src/diffpress/discoverRepos.ts src/diffpress/discoverRepos.test.ts
git commit -m "feat(diffpress): gate discovery by interest-to-coverage via Tavily"
```

---

## Task 5: Project coverageScore through the ledger

**Files:**
- Modify: `src/diffpress/lib/ledger.ts:205-207`

`toDiscoveredRecord` (Task 4) already writes `coverageScore`/`coverageSources` onto the row. The board badge needs `coverageScore` in the projection; `coverageSources` is intentionally NOT projected (keeps the list payload small).

- [ ] **Step 1: Add `coverageScore` to the `queryByStatus` projection**

In `src/diffpress/lib/ledger.ts`, find the `ProjectionExpression` string inside `queryByStatus` (line 205–206) ending in `..., starsGained, releaseTag` and append `, coverageScore`:

```typescript
      ProjectionExpression:
        "repoName, #status, repoUrl, taskToken, discoveredAt, title, publishedAt, description, stars, #lang, pushedAt, signalType, starsGained, releaseTag, coverageScore",
```

- [ ] **Step 2: Verify compile + ledger tests**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts && npx tsc --noEmit`
Expected: PASS (no projection-related test asserts the exact string; if one does, update it to include `coverageScore`).

- [ ] **Step 3: Commit**

```bash
git add src/diffpress/lib/ledger.ts
git commit -m "feat(diffpress): project coverageScore from the status GSI"
```

---

## Task 6: Surface coverageScore in the board API

**Files:**
- Modify: `src/diffpress/listHandoffs.ts`

- [ ] **Step 1: Add `coverageScore` to `DiscoveredItem`**

In `src/diffpress/listHandoffs.ts`, add to the `DiscoveredItem` interface (after `releaseTag?: string;` on line 15):

```typescript
  coverageScore?: number;
```

- [ ] **Step 2: Map it in `bucketBoard`**

In the `case "DISCOVERED":` block, add after `releaseTag: item.releaseTag,` (line 58):

```typescript
          coverageScore: item.coverageScore,
```

- [ ] **Step 3: Verify**

Run: `npx vitest run src/diffpress/listHandoffs.test.ts && npx tsc --noEmit`
Expected: PASS. (If a `bucketBoard` test asserts the exact discovered-item shape, add `coverageScore` to its expectation.)

- [ ] **Step 4: Commit**

```bash
git add src/diffpress/listHandoffs.ts
git commit -m "feat(diffpress): include coverageScore in the board API"
```

---

## Task 7: Cite coverage sources in the drafting prompt

**Files:**
- Modify: `src/diffpress/draftArticle.ts:26-69`
- Test: `src/diffpress/draftArticle.test.ts`

`buildDraftPrompt` already receives `repo` (the in-flight `RepoCandidate`, which carries `coverageSources` from `discoverRepos` through the Step Functions state). Add a section rendered from `repo.coverageSources`.

- [ ] **Step 1: Write the failing tests**

Add to `src/diffpress/draftArticle.test.ts`:

```typescript
import { buildDraftPrompt } from "./draftArticle";
import type { RepoCandidate, EnrichmentPayload } from "./types";

function repoWith(sources: RepoCandidate["coverageSources"]): RepoCandidate {
  return {
    repoName: "acme/widget",
    repoUrl: "https://github.com/acme/widget",
    description: "A widget",
    stars: 100,
    language: "TS",
    pushedAt: "2026-06-10T00:00:00Z",
    coverageSources: sources,
  };
}

const enrichment: EnrichmentPayload = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  documentation: "docs",
  sentiment: [],
  generatedAt: "2026-06-17T00:00:00Z",
};

describe("buildDraftPrompt coverage section", () => {
  it("lists coverage sources when present", () => {
    const prompt = buildDraftPrompt({
      repo: repoWith([
        { title: "Existing Guide", url: "https://dev.to/x", domain: "dev.to", abstract: "an intro", relevanceScore: 0.9 },
      ]),
      enrichment,
      notes: "n",
    });
    expect(prompt).toContain("Existing coverage");
    expect(prompt).toContain("Existing Guide");
    expect(prompt).toContain("dev.to");
  });

  it("renders a fallback when there are no sources", () => {
    const prompt = buildDraftPrompt({
      repo: repoWith(undefined),
      enrichment,
      notes: "n",
    });
    expect(prompt).toContain("no prior coverage found");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/diffpress/draftArticle.test.ts -t "coverage section"`
Expected: FAIL — the prompt has no coverage section yet.

- [ ] **Step 3: Render the coverage section in `buildDraftPrompt`**

In `src/diffpress/draftArticle.ts`, inside `buildDraftPrompt`, after the `const sentiment = ...` block (line 36) add:

```typescript
  const coverage =
    (repo.coverageSources ?? [])
      .map((s) => `- "${s.title}" (${s.domain}) — ${s.abstract}`)
      .join("\n") || "(no prior coverage found)";
```

Then insert a new section into the returned array, immediately before the `## Author's notes` section (before the `` `## Author's notes (primary source — drives both content and mode)` `` line):

```typescript
    `## Existing coverage (review the literature, then differentiate)`,
    `The following third-party articles already cover this subject. Orient the piece against them: reference them where useful, and find an angle they miss. Do not duplicate their framing.`,
    coverage,
    ``,
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/diffpress/draftArticle.test.ts -t "coverage section"`
Expected: PASS.

- [ ] **Step 5: Run the full draftArticle suite**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/draftArticle.ts src/diffpress/draftArticle.test.ts
git commit -m "feat(diffpress): cite existing coverage in the drafting prompt"
```

---

## Task 8: Frontend types

**Files:**
- Modify: `src/components/diffpress/types.ts`

- [ ] **Step 1: Add `coverageScore` to `DiscoveryCard`**

In `src/components/diffpress/types.ts`, add to `DiscoveryCard` (after `releaseTag?: string;` on line 24):

```typescript
  /** Existing-coverage score 0..1 (higher = more covered). Drives the chip. */
  coverageScore?: number;
```

- [ ] **Step 2: Add `coverageScore` to the handoff `discovered` item type**

In the same file, the API-response interface around line 115 mirrors `DiscoveredItem` (it has `signalType`/`starsGained`/`releaseTag`). Add after `releaseTag?: string;` on line 117:

```typescript
    coverageScore?: number;
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/types.ts
git commit -m "feat(diffpress): frontend coverageScore on DiscoveryCard + API type"
```

---

## Task 9: Map coverageScore in the service layer

**Files:**
- Modify: `src/components/diffpress/services.ts:30-42`

- [ ] **Step 1: Map the field**

In `fetchCandidates`, inside the `discovery: board.discovered.map(...)` object, add after `releaseTag: d.releaseTag,` (line 41):

```typescript
      coverageScore: d.coverageScore,
```

- [ ] **Step 2: Verify**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/diffpress/services.ts
git commit -m "feat(diffpress): map coverageScore in the discovery service"
```

---

## Task 10: Coverage chip on the board

**Files:**
- Modify: `src/components/diffpress/Dashboard.tsx`

A 3-tier chip (Low <0.33 / Med 0.33–0.66 / High ≥0.66) rendered in the card meta row next to the reason badge. Cards with no `coverageScore` (fail-open) render no chip.

- [ ] **Step 1: Add a pure tier helper**

In `src/components/diffpress/Dashboard.tsx`, after `reasonBadge` (after line 33), add:

```typescript
/** 3-tier coverage label from a 0..1 score, or null when unknown. */
function coverageTier(score: number | undefined): string | null {
  if (typeof score !== "number") return null;
  if (score < 0.33) return "Low coverage";
  if (score < 0.66) return "Med coverage";
  return "High coverage";
}
```

- [ ] **Step 2: Render the chip in `DiscoveryArticle`**

In `DiscoveryArticle`, after `const badge = reasonBadge(card);` (line 80) add:

```typescript
  const coverage = coverageTier(card.coverageScore);
```

Then in the meta row, after the `language` span (line 101), add:

```typescript
        {coverage ? <span className="text-dp-slate">{coverage}</span> : null}
```

- [ ] **Step 3: Verify build**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/Dashboard.tsx
git commit -m "feat(diffpress): 3-tier coverage chip on discovery cards"
```

---

## Task 11: Provision the Tavily secret in SST

**Files:**
- Modify: `sst.config.ts`

- [ ] **Step 1: Declare the secret**

In `sst.config.ts`, after the `GOOGLE_BOOKS_API_KEY` secret declaration (line 19) add:

```typescript
    const TAVILY_API_KEY = new sst.Secret("TAVILY_API_KEY");
```

- [ ] **Step 2: Link it to discoverRepos**

In the `discoverRepos` function definition (line 466–469), add `TAVILY_API_KEY` to the `link` array:

```typescript
      discoverRepos: new sst.aws.Function("DiffPressDiscoverRepos", {
        handler: "src/diffpress/discoverRepos.handler",
        link: [GITHUB_TOKEN, publicationLifecycle, discoverySignals, discoveryConfig, TAVILY_API_KEY],
        timeout: "120 seconds",
      }),
```

- [ ] **Step 3: Operator note (no command run here)**

Before deploy, the operator must set the secret value (documented for the deploy step, not executed by the implementing agent):

```bash
npx sst secret set TAVILY_API_KEY <key> --stage prod
```

> Do not run `sst deploy` as part of this plan. Deploy is a manual operator step (see the project's discovery deploy checklist).

- [ ] **Step 4: Verify config parses**

Run: `npx tsc --noEmit`
Expected: PASS. (`tavily.ts` already reads the key via the `Resource as unknown as {...}` cast from Task 3, so a missing typegen entry for `TAVILY_API_KEY` does not break `tsc`. See [[sst-typegen-gotchas]].)

- [ ] **Step 5: Commit**

```bash
git add sst.config.ts
git commit -m "feat(diffpress): TAVILY_API_KEY secret linked to discoverRepos"
```

---

## Task 12: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: PASS — all suites green (previous baseline 74 tests + new coverage/tavily/discover/draft cases).

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Final commit (if any incidental changes)**

```bash
git status   # expect clean; if test snapshots updated, commit them
```

---

## Notes for the implementer

- **TDD order matters across Tasks 2 & 3:** `coverage.test.ts` imports `TavilyResult` from `./tavily`. Either create `lib/tavily.ts` first (Task 3 Step 3) or stub the type. The recommended execution order is 1 → 3 → 2 → 4 … but the plan is written 1 → 2 → 3 so the pure logic reads first; if executing strictly in order, create a minimal `lib/tavily.ts` exporting `TavilyResult` before running Task 2's tests.
- **Fail-open is load-bearing:** never let a Tavily outage throw out of `scoreAndGateCandidates`; a candidate with a failed call must pass through unscored.
- **`coverageSources` reaches `draftArticle` via Step Functions state** (`state.repo`), not via a ledger read — no extra fetch. The ledger copy is persisted but not projected to the board list.
- **Deploy is out of scope** for this plan; it's a manual operator step that also requires setting `TAVILY_API_KEY`. See [[diffpress-real-discovery]] for the deploy/backfill checklist.
- See [[diffpress-real-discovery]] and the design spec `docs/superpowers/specs/2026-06-17-interest-to-coverage-scoring-design.md` for rationale.
