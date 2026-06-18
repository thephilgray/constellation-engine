import { describe, it, expect } from "vitest";
import {
  buildCoverageQuery,
  scoreCoverage,
  dropOverCovered,
  rankByInterestToCoverage,
  toCoverageSources,
  DROP_THRESHOLD,
  SOURCE_RELEVANCE_FLOOR,
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
      result("https://b.com/x", 0.4), // below depth floor (0.5) but above breadth floor → counts for breadth, not depth
    ];
    const score = scoreCoverage(results, repo);
    // 2 distinct domains breadth, but only 1 qualifying depth result
    expect(score.coverageScore).toBeGreaterThan(0);
  });

  it("excludes below-floor noise results from breadth", () => {
    const results = [
      result("https://real.com/x", 0.8),
      result("https://noise.com/x", 0.1), // below source floor → not even breadth
    ];
    const score = scoreCoverage(results, repo);
    // only real.com counts: breadth = 1/6, depth = 1/5
    const expected = 0.6 * (1 / 6) + 0.4 * (1 / 5);
    expect(score.coverageScore).toBeCloseTo(expected, 5);
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

  it("drops results below the source relevance floor", () => {
    const results = [
      result("https://good.com/p", 0.8),
      result("https://junk.com/profile", 0.0074),
    ];
    const sources = toCoverageSources(results);
    expect(sources).toHaveLength(1);
    expect(sources[0].domain).toBe("good.com");
  });

  it("keeps a result exactly at the floor", () => {
    const results = [result("https://edge.com/p", SOURCE_RELEVANCE_FLOOR)];
    expect(toCoverageSources(results)).toHaveLength(1);
  });
});
