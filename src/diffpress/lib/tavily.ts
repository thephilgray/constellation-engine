// Thin I/O wrapper around the Tavily Search API. The only network/impure part
// of coverage scoring. Lane/scoring logic lives in lib/coverage.ts.
import { Resource } from "sst";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
/** Max results requested per query (enough to count breadth + fill sources). */
const MAX_RESULTS = 10;

// Read the key lazily through an unknown cast: SST only adds TAVILY_API_KEY to
// the Resource types after a deploy/dev regenerates sst-env.d.ts, so this keeps
// `tsc --noEmit` green beforehand. See [[sst-typegen-gotchas]].
function apiKey(): string {
  return (Resource as unknown as { TAVILY_API_KEY: { value: string } })
    .TAVILY_API_KEY.value;
}

/**
 * Domains that are never genuine third-party coverage: package registries /
 * mirrors, plus social/aggregator sites whose profile and post pages otherwise
 * inflate breadth with noise (e.g. a stranger's LinkedIn profile).
 */
export const EXCLUDE_DOMAINS = [
  "github.com",
  "npmjs.com",
  "pypi.org",
  "crates.io",
  "libraries.io",
  "packagist.org",
  "rubygems.org",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "reddit.com",
  "medium.com",
];

/** One normalized Tavily search result. */
export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

/** Pure: map a raw Tavily response body to typed results, dropping bad rows. */
export function mapTavilyResponse(body: unknown): TavilyResult[] {
  const results = (body as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: TavilyResult[] = [];
  for (const r of results) {
    const row = r as Record<string, unknown>;
    if (typeof row.url !== "string") continue;
    out.push({
      title: typeof row.title === "string" ? row.title : "",
      url: row.url,
      content: typeof row.content === "string" ? row.content : "",
      score: typeof row.score === "number" ? row.score : 0,
    });
  }
  return out;
}

/**
 * Run one general web search for the given query. Throws on network/HTTP error
 * (the caller in discoverRepos applies the fail-open policy).
 */
export async function searchCoverage(query: string): Promise<TavilyResult[]> {
  const res = await fetch(TAVILY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey()}`,
    },
    body: JSON.stringify({
      query,
      max_results: MAX_RESULTS,
      exclude_domains: EXCLUDE_DOMAINS,
      search_depth: "basic",
    }),
  });
  if (!res.ok) {
    throw new Error(`Tavily search failed: ${res.status} ${res.statusText}`);
  }
  return mapTavilyResponse(await res.json());
}
