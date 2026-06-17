import { describe, it, expect } from "vitest";
import {
  dedupeByExisting,
  aggregateSignals,
  assignLane,
  activeLanesFor,
  laneBudgets,
  capPerLane,
  toDiscoveredRecord,
} from "./discoverRepos";
import type { SignalRow } from "./lib/signals";
import type { RepoCandidate } from "./types";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const candidate = (repoName: string, signalType: RepoCandidate["signalType"]): RepoCandidate => ({
  repoName,
  repoUrl: `https://github.com/${repoName}`,
  description: "desc",
  stars: 100,
  language: "TypeScript",
  pushedAt: "2026-06-10T00:00:00.000Z",
  signalType,
  starsGained: 42,
});

const starRow = (repoName: string, count: number, bucketMs: number): SignalRow => ({
  repoName,
  signalKey: `STAR#${bucketMs}`,
  signalType: "STAR",
  bucketMs,
  count,
  repoUrl: `https://github.com/${repoName}`,
  ttl: 0,
});

const releaseRow = (repoName: string, tag: string, bucketMs: number): SignalRow => ({
  repoName,
  signalKey: `RELEASE#${bucketMs}`,
  signalType: "RELEASE",
  bucketMs,
  releaseTag: tag,
  repoUrl: `https://github.com/${repoName}`,
  ttl: 0,
});

describe("dedupeByExisting", () => {
  it("drops items whose repoName already exists", () => {
    const items = [{ repoName: "a/one" }, { repoName: "b/two" }];
    expect(dedupeByExisting(items, new Set(["b/two"]))).toEqual([{ repoName: "a/one" }]);
  });
});

describe("aggregateSignals", () => {
  const now = Date.parse("2026-06-16T12:00:00Z");

  it("sums stars in-window and ranks by velocity, keeping latest release tag", () => {
    const rows: SignalRow[] = [
      starRow("hot/repo", 10, now - 1 * DAY),
      starRow("hot/repo", 5, now - 2 * DAY),
      starRow("warm/repo", 8, now - 1 * DAY),
      releaseRow("warm/repo", "v1.0.0", now - 3 * DAY),
      releaseRow("warm/repo", "v1.1.0", now - 1 * DAY), // latest
      starRow("stale/repo", 99, now - 9 * DAY), // outside 7-day window
    ];
    const agg = aggregateSignals(rows, now, 7);

    expect(agg.map((r) => r.repoName)).toEqual(["hot/repo", "warm/repo"]);
    expect(agg[0]).toMatchObject({ repoName: "hot/repo", starsGained: 15, releasedInWindow: false });
    expect(agg[1]).toMatchObject({ starsGained: 8, releasedInWindow: true, releaseTag: "v1.1.0" });
  });

  it("includes release-only repos with zero stars gained", () => {
    const agg = aggregateSignals([releaseRow("ship/repo", "v2", now - 1 * DAY)], now, 7);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ starsGained: 0, releasedInWindow: true, releaseTag: "v2" });
  });
});

describe("assignLane", () => {
  const now = Date.parse("2026-06-16T12:00:00Z");
  it("classifies recently-created repos as NEW (highest precedence)", () => {
    const createdAt = new Date(now - 5 * DAY).toISOString();
    expect(assignLane(createdAt, true, now, 30)).toBe("NEW");
  });
  it("classifies older released repos as RELEASE", () => {
    const createdAt = new Date(now - 365 * DAY).toISOString();
    expect(assignLane(createdAt, true, now, 30)).toBe("RELEASE");
  });
  it("falls back to TRENDING", () => {
    const createdAt = new Date(now - 365 * DAY).toISOString();
    expect(assignLane(createdAt, false, now, 30)).toBe("TRENDING");
  });
});

describe("activeLanesFor", () => {
  it("maps each mode to its lanes", () => {
    expect(activeLanesFor("frontier")).toEqual(["NEW", "TRENDING"]);
    expect(activeLanesFor("ecosystem")).toEqual(["RELEASE"]);
    expect(activeLanesFor("balanced")).toEqual(["TRENDING", "NEW", "RELEASE"]);
  });
});

describe("laneBudgets", () => {
  it("splits the budget evenly", () => {
    expect(laneBudgets(6, ["NEW", "TRENDING", "RELEASE"])).toEqual(
      new Map([["NEW", 2], ["TRENDING", 2], ["RELEASE", 2]])
    );
  });
  it("gives the remainder to earlier lanes", () => {
    expect(laneBudgets(7, ["NEW", "TRENDING", "RELEASE"])).toEqual(
      new Map([["NEW", 3], ["TRENDING", 2], ["RELEASE", 2]])
    );
  });
  it("puts the whole budget on a single active lane", () => {
    expect(laneBudgets(6, ["RELEASE"])).toEqual(new Map([["RELEASE", 6]]));
  });
});

describe("capPerLane", () => {
  const cands = [
    candidate("a/1", "TRENDING"),
    candidate("a/2", "TRENDING"),
    candidate("a/3", "TRENDING"),
    candidate("b/1", "NEW"),
    candidate("c/1", "RELEASE"),
  ];

  it("caps each lane to its budget, preserving order", () => {
    const out = capPerLane(
      cands,
      new Map([["TRENDING", 2], ["NEW", 2], ["RELEASE", 2]])
    );
    expect(out.map((c) => c.repoName)).toEqual(["a/1", "a/2", "b/1", "c/1"]);
  });

  it("drops candidates in lanes that are inactive for the mode", () => {
    // ecosystem mode → only RELEASE has budget
    const out = capPerLane(cands, new Map([["RELEASE", 6]]));
    expect(out.map((c) => c.repoName)).toEqual(["c/1"]);
  });
});

describe("toDiscoveredRecord", () => {
  it("maps a candidate to a DISCOVERED record with signal fields and a 10-day TTL", () => {
    const now = 1_780_000_000_000;
    const rec = toDiscoveredRecord(candidate("a/one", "NEW"), now);
    expect(rec.status).toBe("DISCOVERED");
    expect(rec.signalType).toBe("NEW");
    expect(rec.starsGained).toBe(42);
    expect(rec.ttl).toBe(Math.floor(now / 1000) + 10 * 24 * 60 * 60);
  });
});

// --- Interest-to-Coverage gating ---
import { vi, beforeEach } from "vitest";

vi.mock("./lib/tavily", () => ({
  searchCoverage: vi.fn(),
  EXCLUDE_DOMAINS: [],
}));

import { scoreAndGateCandidates } from "./discoverRepos";
import { searchCoverage } from "./lib/tavily";

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
  // Block body (not an expression arrow): returning the Mock from mockReset()
  // trips a vitest v4 unhandled-rejection false-positive on the fail-open path.
  beforeEach(() => {
    vi.mocked(searchCoverage).mockReset();
  });

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
