import { describe, it, expect } from "vitest";
import { buildDocumentation, README_CHAR_CAP } from "./enrichRepos";

describe("buildDocumentation", () => {
  it("uses the README when present", () => {
    const doc = buildDocumentation("acme/widget", "Widget desc", "# Real README\n\nUsage...");
    expect(doc).toContain("# Real README");
    expect(doc).toContain("Usage...");
  });

  it("falls back to description-only when README is null", () => {
    const doc = buildDocumentation("acme/widget", "Widget desc", null);
    expect(doc).toContain("acme/widget");
    expect(doc).toContain("Widget desc");
    expect(doc).not.toContain("README");
  });

  it("falls back to description-only when README is blank", () => {
    const doc = buildDocumentation("acme/widget", "Widget desc", "   \n  ");
    expect(doc).toContain("Widget desc");
  });

  it("truncates an over-long README to the cap with a marker", () => {
    const huge = "x".repeat(README_CHAR_CAP + 5000);
    const doc = buildDocumentation("acme/widget", "Widget desc", huge);
    expect(doc.length).toBeLessThan(README_CHAR_CAP + 200);
    expect(doc).toContain("[truncated]");
  });
});
