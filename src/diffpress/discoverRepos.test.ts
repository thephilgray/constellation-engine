import { describe, it, expect } from "vitest";
import { dedupeByExisting, toDiscoveredRecord } from "./discoverRepos";
import type { RepoCandidate } from "./types";

const candidate = (repoName: string): RepoCandidate => ({
  repoName,
  repoUrl: `https://github.com/${repoName}`,
  description: "desc",
  stars: 100,
  language: "TypeScript",
  pushedAt: "2026-06-10T00:00:00.000Z",
});

describe("dedupeByExisting", () => {
  it("drops candidates whose repoName already exists in the ledger", () => {
    const candidates = [candidate("a/one"), candidate("b/two"), candidate("c/three")];
    const result = dedupeByExisting(candidates, new Set(["b/two"]));
    expect(result.map((r) => r.repoName)).toEqual(["a/one", "c/three"]);
  });

  it("returns all candidates when nothing exists yet", () => {
    expect(dedupeByExisting([candidate("a/one")], new Set())).toHaveLength(1);
  });
});

describe("toDiscoveredRecord", () => {
  it("maps a candidate to a DISCOVERED ledger record with a TTL", () => {
    const now = 1_780_000_000_000; // fixed epoch ms
    const rec = toDiscoveredRecord(candidate("a/one"), now);
    expect(rec.status).toBe("DISCOVERED");
    expect(rec.repoName).toBe("a/one");
    expect(rec.stars).toBe(100);
    expect(rec.language).toBe("TypeScript");
    expect(rec.pushedAt).toBe("2026-06-10T00:00:00.000Z");
    // 30 days in seconds past `now`.
    expect(rec.ttl).toBe(Math.floor(now / 1000) + 30 * 24 * 60 * 60);
  });
});
