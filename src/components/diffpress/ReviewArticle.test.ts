import { describe, it, expect } from "vitest";
import { anchorNotesToBlocks } from "./ReviewArticle";
import type { ReviewNote } from "./types";

const note = (id: string, anchorText: string): ReviewNote => ({
  id,
  anchorText,
  note: "n",
  replacement: "r",
});

const blocks = [
  { text: "The premise is simple." },
  { text: "Underneath, Helix is event-sourced." },
  { text: "The elegance has a cost." },
];

describe("anchorNotesToBlocks", () => {
  it("anchors a note to the first block containing its verbatim anchorText", () => {
    const { byBlock, orphans } = anchorNotesToBlocks(blocks, [note("a", "event-sourced")]);
    expect(byBlock.get(1)?.map((n) => n.id)).toEqual(["a"]);
    expect(orphans).toHaveLength(0);
  });

  it("returns unmatched notes as orphans", () => {
    const { byBlock, orphans } = anchorNotesToBlocks(blocks, [note("x", "no such text")]);
    expect(byBlock.size).toBe(0);
    expect(orphans.map((n) => n.id)).toEqual(["x"]);
  });

  it("stacks multiple notes that land in the same block", () => {
    const notes = [note("a", "The premise"), note("b", "is simple")];
    const { byBlock } = anchorNotesToBlocks(blocks, notes);
    expect(byBlock.get(0)?.map((n) => n.id)).toEqual(["a", "b"]);
  });
});
