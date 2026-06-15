import { describe, it, expect } from "vitest";
import { filterUnpublished } from "./discoverRepos";
import type { RepoCandidate } from "./types";

const candidate = (repoName: string): RepoCandidate => ({
  repoName,
  repoUrl: `https://github.com/${repoName}`,
  description: "",
  stars: 100,
  language: "TypeScript",
});

describe("filterUnpublished", () => {
  it("removes candidates whose repoName is already published", () => {
    const candidates = [candidate("a/one"), candidate("b/two"), candidate("c/three")];
    const result = filterUnpublished(candidates, ["b/two"]);
    expect(result.map((r) => r.repoName)).toEqual(["a/one", "c/three"]);
  });

  it("returns all candidates when nothing is published", () => {
    const candidates = [candidate("a/one")];
    expect(filterUnpublished(candidates, [])).toHaveLength(1);
  });
});
