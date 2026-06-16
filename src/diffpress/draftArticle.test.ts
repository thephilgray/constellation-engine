import { describe, it, expect } from "vitest";
import { buildDraftPrompt, parseDraftResponse } from "./draftArticle";
import type { RepoCandidate, EnrichmentPayload } from "./types";

const repo: RepoCandidate = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  description: "A widget toolkit",
  stars: 1234,
  language: "TypeScript",
};

const enrichment: EnrichmentPayload = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  documentation: "Widget docs body.",
  sentiment: [{ source: "hackernews", summary: "People like it.", score: 0.8 }],
  generatedAt: "2026-06-15T00:00:00.000Z",
};

describe("buildDraftPrompt", () => {
  it("includes repo metadata, docs, sentiment, and notes", () => {
    const p = buildDraftPrompt({ repo, enrichment, notes: "I built a demo app." });
    expect(p).toContain("acme/widget");
    expect(p).toContain("https://github.com/acme/widget");
    expect(p).toContain("A widget toolkit");
    expect(p).toContain("TypeScript");
    expect(p).toContain("Widget docs body.");
    expect(p).toContain("People like it.");
    expect(p).toContain("I built a demo app.");
  });

  it("explains both modes and the directive-honoring rule", () => {
    const p = buildDraftPrompt({ repo, enrichment, notes: "" });
    expect(p).toContain("explainer");
    expect(p).toContain("narrative");
    expect(p.toLowerCase()).toContain("mode:");
  });
});

describe("parseDraftResponse", () => {
  it("parses a valid JSON response", () => {
    const raw = JSON.stringify({ title: "My Title", articleMarkdown: "## Body" });
    expect(parseDraftResponse(raw)).toEqual({ title: "My Title", articleMarkdown: "## Body" });
  });

  it("throws on empty output", () => {
    expect(() => parseDraftResponse("   ")).toThrow(/empty/i);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseDraftResponse("not json")).toThrow(/valid JSON/i);
  });

  it("throws when a required field is missing", () => {
    expect(() => parseDraftResponse(JSON.stringify({ title: "x" }))).toThrow(/missing/i);
  });
});
