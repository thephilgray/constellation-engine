import { describe, it, expect } from "vitest";
import { draftKey, parseDraftKeys } from "./draftStore";

describe("draftKey", () => {
  it("builds a timestamped key under the repo prefix (slash preserved)", () => {
    expect(draftKey("forge/sigil", "2026-06-23T21:00:00.000Z")).toBe(
      "drafts/forge/sigil/2026-06-23T21:00:00.000Z.json"
    );
  });
});

describe("parseDraftKeys", () => {
  it("extracts timestamps newest-first, ignoring non-matching keys", () => {
    const keys = [
      "drafts/forge/sigil/2026-06-23T21:00:00.000Z.json",
      "drafts/forge/sigil/2026-06-23T22:30:00.000Z.json",
      "drafts/forge/sigil/2026-06-23T20:00:00.000Z.json",
      "drafts/forge/sigil/", // prefix placeholder, no ts
    ];
    expect(parseDraftKeys(keys)).toEqual([
      { ts: "2026-06-23T22:30:00.000Z" },
      { ts: "2026-06-23T21:00:00.000Z" },
      { ts: "2026-06-23T20:00:00.000Z" },
    ]);
  });

  it("handles repo names with slashes when extracting the ts", () => {
    expect(
      parseDraftKeys(["drafts/a/b/c/2026-06-23T21:00:00.000Z.json"])
    ).toEqual([{ ts: "2026-06-23T21:00:00.000Z" }]);
  });
});
