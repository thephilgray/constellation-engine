import { describe, it, expect, vi, afterEach } from "vitest";

// Mock the SST Resource so importing the module needs no real binding.
vi.mock("sst", () => ({
  Resource: { TAVILY_API_KEY: { value: "test-key" } },
}));

import { mapTavilyResponse, EXCLUDE_DOMAINS } from "./tavily";

afterEach(() => vi.restoreAllMocks());

describe("mapTavilyResponse", () => {
  it("maps results to typed TavilyResult[], dropping malformed entries", () => {
    const raw = {
      results: [
        { title: "Guide", url: "https://dev.to/x", content: "body", score: 0.91 },
        { title: "No url", content: "x", score: 0.5 }, // dropped (no url)
        { url: "https://b.com", content: "y", score: 0.3 }, // title defaults to ""
      ],
    };
    const mapped = mapTavilyResponse(raw);
    expect(mapped).toEqual([
      { title: "Guide", url: "https://dev.to/x", content: "body", score: 0.91 },
      { title: "", url: "https://b.com", content: "y", score: 0.3 },
    ]);
  });

  it("returns [] when results is missing", () => {
    expect(mapTavilyResponse({})).toEqual([]);
  });

  it("excludes registry/mirror domains by default", () => {
    expect(EXCLUDE_DOMAINS).toContain("npmjs.com");
    expect(EXCLUDE_DOMAINS).toContain("github.com");
  });

  it("excludes social/aggregator domains that are not real coverage", () => {
    expect(EXCLUDE_DOMAINS).toContain("linkedin.com");
    expect(EXCLUDE_DOMAINS).toContain("twitter.com");
    expect(EXCLUDE_DOMAINS).toContain("x.com");
    expect(EXCLUDE_DOMAINS).toContain("facebook.com");
    expect(EXCLUDE_DOMAINS).toContain("instagram.com");
    expect(EXCLUDE_DOMAINS).toContain("reddit.com");
  });
});
