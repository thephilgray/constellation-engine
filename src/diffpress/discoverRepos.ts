import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { batchGetExisting, batchPutDiscovered } from "./lib/ledger";
import type { RepoCandidate, ContentEngineState, PublicationRecord } from "./types";

const DISCOVERY_TTL_DAYS = 30;

/** Pure: drop candidates already present in the ledger (any status). */
export function dedupeByExisting(
  candidates: RepoCandidate[],
  existing: Set<string>
): RepoCandidate[] {
  return candidates.filter((c) => !existing.has(c.repoName));
}

/** Pure: map a fresh candidate to a DISCOVERED ledger row with a 30-day TTL. */
export function toDiscoveredRecord(
  c: RepoCandidate,
  nowMs: number
): PublicationRecord {
  return {
    repoName: c.repoName,
    status: "DISCOVERED",
    repoUrl: c.repoUrl,
    description: c.description,
    stars: c.stars,
    language: c.language,
    pushedAt: c.pushedAt,
    discoveredAt: new Date(nowMs).toISOString(),
    ttl: Math.floor(nowMs / 1000) + DISCOVERY_TTL_DAYS * 24 * 60 * 60,
  };
}

/** Build the "emerging repos" search query: created in the last 30 days, popular. */
function emergingQuery(): string {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return `created:>${since} stars:>50`;
}

export async function handler(): Promise<ContentEngineState> {
  const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });

  const { data } = await octokit.rest.search.repos({
    q: emergingQuery(),
    sort: "stars",
    order: "desc",
    per_page: 50,
  });

  const candidates: RepoCandidate[] = data.items.map((item) => ({
    repoName: item.full_name,
    repoUrl: item.html_url,
    description: item.description ?? "",
    stars: item.stargazers_count,
    language: item.language ?? null,
    pushedAt: item.pushed_at ?? new Date().toISOString(),
  }));

  // Dedup against the whole ledger via BatchGetItem (no table scan).
  const existing = await batchGetExisting(candidates.map((c) => c.repoName));
  const fresh = dedupeByExisting(candidates, existing);

  if (fresh.length === 0) {
    throw new Error("No un-seen emerging repos found this cycle.");
  }

  // Persist the whole fresh pool as DISCOVERED so the UI can show it.
  const now = Date.now();
  await batchPutDiscovered(fresh.map((c) => toDiscoveredRecord(c, now)));

  const repo = fresh[0];
  console.log(`[discoverRepos] wrote ${fresh.length} DISCOVERED; selected ${repo.repoName}`);
  return { repo, candidates: fresh };
}
