import { describe, it, expect, vi } from "vitest";

vi.mock("./services", async (orig) => ({
  ...(await orig<typeof import("./services")>()),
  runReviewStream: vi.fn(async (_r: string, _m: string, onNote: (n: any) => void) => {
    onNote({ id: "n1", anchorText: "a", note: "x", replacement: "b" });
    onNote({ id: "n2", anchorText: "c", note: "y", replacement: "d" });
  }),
}));

import { removeFromPipeline, useDiffPress } from "./store";
import type { PipelineData } from "./types";

const base: PipelineData = {
  discovery: [
    { id: "a/b", repo: "a/b", desc: "", stars: 0, language: "", lastUpdated: "" },
    { id: "c/d", repo: "c/d", desc: "", stars: 0, language: "", lastUpdated: "" },
  ],
  readyForDev: [{ id: "e/f", repo: "e/f", desc: "" }],
  drafting: [],
  inReview: [],
  published: [],
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

describe("runReview (streaming)", () => {
  it("appends each streamed note and reveals it immediately", async () => {
    useDiffPress.setState({ articleRepo: "a/b", articleMarkdown: "# hi", notes: [], revealedNoteIds: [] });
    await useDiffPress.getState().runReview();
    const s = useDiffPress.getState();
    expect(s.notes).toHaveLength(2);
    expect(s.revealedNoteIds).toEqual(["n1", "n2"]);
    expect(s.reviewing).toBe(false);
    expect(s.reviewError).toBeNull();
  });
});
