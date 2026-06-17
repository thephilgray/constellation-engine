import { describe, it, expect } from "vitest";
import {
  dedupeByExisting,
  aggregateSignals,
  assignLane,
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

describe("capPerLane", () => {
  it("keeps at most N per lane, preserving order", () => {
    const cands = [
      candidate("a/1", "TRENDING"),
      candidate("a/2", "TRENDING"),
      candidate("a/3", "TRENDING"),
      candidate("b/1", "NEW"),
      candidate("c/1", "RELEASE"),
    ];
    const out = capPerLane(cands, 2);
    expect(out.map((c) => c.repoName)).toEqual(["a/1", "a/2", "b/1", "c/1"]);
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
