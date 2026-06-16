import { describe, it, expect } from "vitest";
import { parseRepoSlug, assembleNotes } from "./devNotes";

describe("parseRepoSlug", () => {
  it("parses a standard https GitHub URL", () => {
    expect(parseRepoSlug("https://github.com/acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("strips a trailing .git", () => {
    expect(parseRepoSlug("https://github.com/acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("ignores extra path segments", () => {
    expect(parseRepoSlug("https://github.com/acme/widget/tree/main")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseRepoSlug("https://gitlab.com/acme/widget")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseRepoSlug("not a url")).toBeNull();
  });
});

describe("assembleNotes", () => {
  it("uses the file as primary and appends the UI log when both exist", () => {
    const out = assembleNotes("# File notes", "ui log line");
    expect(out).toContain("# File notes");
    expect(out).toContain("ui log line");
    expect(out.indexOf("# File notes")).toBeLessThan(out.indexOf("ui log line"));
  });

  it("returns the file notes alone when there is no UI log", () => {
    expect(assembleNotes("# File notes", "")).toBe("# File notes");
  });

  it("falls back to the UI log when there is no file", () => {
    expect(assembleNotes(null, "ui log line")).toBe("ui log line");
  });

  it("returns empty string when both are empty", () => {
    expect(assembleNotes(null, "   ")).toBe("");
  });
});
