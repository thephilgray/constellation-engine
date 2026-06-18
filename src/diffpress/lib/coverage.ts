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
/**
 * A result is kept as a persisted/drafter-facing source only if its relevance
 * score >= this. Lower than the depth floor: marginally-relevant pages are
 * still useful literature context, but near-zero noise (e.g. 0.0074) is dropped.
 */
export const SOURCE_RELEVANCE_FLOOR = 0.3;
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
    if (r.score < SOURCE_RELEVANCE_FLOOR) continue; // near-zero noise never counts
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
    if (r.score < SOURCE_RELEVANCE_FLOOR) continue;
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
