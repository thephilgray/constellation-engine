import { describe, it, expect } from "vitest";
import { applyAnchor } from "./applyAnchor";

describe("applyAnchor", () => {
  it("replaces the first occurrence of anchorText when found", () => {
    expect(applyAnchor("the quick brown fox", "quick", "slow")).toEqual({
      applied: true,
      markdown: "the slow brown fox",
    });
  });

  it("replaces only the first occurrence", () => {
    expect(applyAnchor("a a a", "a", "b")).toEqual({ applied: true, markdown: "b a a" });
  });

  it("leaves the text unchanged and flags not-applied when anchorText is absent", () => {
    expect(applyAnchor("hello world", "xyz", "abc")).toEqual({
      applied: false,
      markdown: "hello world",
    });
  });
});
