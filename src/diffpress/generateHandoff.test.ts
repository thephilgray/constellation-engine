import { describe, it, expect } from "vitest";
import { buildMetaPrompt, fallbackHandoffPrompt, resolveHandoff } from "./generateHandoff";
import type { RepoCandidate, SeedIdea, EnrichmentPayload } from "./types";

const repo: RepoCandidate = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  description: "A widget toolkit",
  stars: 1234,
  language: "TypeScript",
  pushedAt: "2026-06-10T00:00:00.000Z",
  coverageSources: [
    { title: "Intro to Widget", url: "https://dev.to/x", domain: "dev.to", abstract: "A tour.", relevanceScore: 0.7 },
  ],
};

const enrichment: EnrichmentPayload = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  documentation: "# Widget\n\nA toolkit for widgets.",
  sentiment: [],
  generatedAt: "2026-06-15T00:00:00.000Z",
};

const seeds: SeedIdea[] = [{ id: "s1", text: "A dashboard that tracks plants", score: 0.8 }];

describe("buildMetaPrompt", () => {
  it("includes repo metadata, README docs, coverage, and seed ideas", () => {
    const p = buildMetaPrompt({ repo, documentation: enrichment.documentation, seedIdeas: seeds });
    expect(p).toContain("acme/widget");
    expect(p).toContain("https://github.com/acme/widget");
    expect(p).toContain("A toolkit for widgets.");
    expect(p).toContain("Intro to Widget");
    expect(p).toContain("dashboard that tracks plants");
  });

  it("instructs both narrative and explainer modes and the fit decision", () => {
    const p = buildMetaPrompt({ repo, documentation: "", seedIdeas: [] });
    expect(p.toLowerCase()).toContain("narrative");
    expect(p.toLowerCase()).toContain("explainer");
    expect(p.toLowerCase()).toContain("not");        // "not hello-world / trivial"
  });

  it("directs logging to DIFFPRESS.md at the demo repo root", () => {
    const p = buildMetaPrompt({ repo, documentation: "", seedIdeas: [] });
    expect(p).toContain("DIFFPRESS.md");
  });

  it("tells the model to differentiate from existing coverage", () => {
    const p = buildMetaPrompt({ repo, documentation: "", seedIdeas: seeds });
    expect(p.toLowerCase()).toContain("differentiate");
  });

  it("handles empty seeds and empty coverage without crashing", () => {
    const bare: RepoCandidate = { ...repo, coverageSources: [] };
    const p = buildMetaPrompt({ repo: bare, documentation: "", seedIdeas: [] });
    expect(p).toContain("acme/widget");
    expect(p).toContain("(none");
  });
});

describe("fallbackHandoffPrompt", () => {
  it("produces a runnable boilerplate brief naming the repo and DIFFPRESS.md", () => {
    const p = fallbackHandoffPrompt("acme/widget");
    expect(p).toContain("acme/widget");
    expect(p).toContain("DIFFPRESS.md");
  });
});

describe("resolveHandoff", () => {
  it("parses valid model output into mode + prompt", () => {
    const raw = JSON.stringify({ mode: "narrative", handoffMarkdown: "# Handoff — acme/widget\nBuild X." });
    expect(resolveHandoff(raw, "acme/widget")).toEqual({
      mode: "narrative",
      handoffPrompt: "# Handoff — acme/widget\nBuild X.",
    });
  });

  it("accepts explainer mode", () => {
    const raw = JSON.stringify({ mode: "explainer", handoffMarkdown: "# Handoff — acme/widget\nExplain it." });
    expect(resolveHandoff(raw, "acme/widget").mode).toBe("explainer");
  });

  it("falls back (no mode, boilerplate prompt) on empty output", () => {
    const r = resolveHandoff("", "acme/widget");
    expect(r.mode).toBeUndefined();
    expect(r.handoffPrompt).toContain("acme/widget");
    expect(r.handoffPrompt).toContain("DIFFPRESS.md");
  });

  it("falls back on non-JSON output", () => {
    const r = resolveHandoff("not json at all", "acme/widget");
    expect(r.mode).toBeUndefined();
    expect(r.handoffPrompt).toContain("DIFFPRESS.md");
  });

  it("falls back on JSON missing fields or invalid mode", () => {
    expect(resolveHandoff(JSON.stringify({ mode: "weird", handoffMarkdown: "x" }), "a/b").mode).toBeUndefined();
    expect(resolveHandoff(JSON.stringify({ handoffMarkdown: "x" }), "a/b").mode).toBeUndefined();
    expect(resolveHandoff(JSON.stringify({ mode: "narrative" }), "a/b").mode).toBeUndefined();
  });
});
