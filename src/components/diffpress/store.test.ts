import { describe, it, expect } from "vitest";
import { removeFromPipeline } from "./store";
import type { PipelineData } from "./types";

const base: PipelineData = {
  discovery: [
    { id: "a/b", repo: "a/b", desc: "", stars: 0, language: "", lastUpdated: "" },
    { id: "c/d", repo: "c/d", desc: "", stars: 0, language: "", lastUpdated: "" },
  ],
  readyForDev: [{ id: "e/f", repo: "e/f", desc: "" }],
  drafting: [],
  inReview: [],
};

describe("removeFromPipeline", () => {
  it("removes a card from whichever column holds it", () => {
    const next = removeFromPipeline(base, "a/b");
    expect(next.discovery.map((c) => c.id)).toEqual(["c/d"]);
    expect(next.readyForDev).toHaveLength(1);
  });

  it("removes from readyForDev too", () => {
    const next = removeFromPipeline(base, "e/f");
    expect(next.readyForDev).toHaveLength(0);
    expect(next.discovery).toHaveLength(2);
  });

  it("is a no-op for an unknown id", () => {
    const next = removeFromPipeline(base, "x/y");
    expect(next.discovery).toHaveLength(2);
    expect(next.readyForDev).toHaveLength(1);
  });
});
