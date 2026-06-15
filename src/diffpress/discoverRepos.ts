import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { listPublishedNames } from "./lib/ledger";
import type { RepoCandidate, ContentEngineState } from "./types";

/** Pure: drop candidates already covered (PUBLISHED) in the ledger. */
export function filterUnpublished(
  candidates: RepoCandidate[],
  publishedNames: string[]
): RepoCandidate[] {
  const published = new Set(publishedNames);
  return candidates.filter((c) => !published.has(c.repoName));
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
    per_page: 25,
  });

  const candidates: RepoCandidate[] = data.items.map((item) => ({
    repoName: item.full_name,
    repoUrl: item.html_url,
    description: item.description ?? "",
    stars: item.stargazers_count,
    language: item.language ?? null,
  }));

  const publishedNames = await listPublishedNames();
  const fresh = filterUnpublished(candidates, publishedNames);

  if (fresh.length === 0) {
    throw new Error("No un-published emerging repos found this cycle.");
  }

  const repo = fresh[0];
  console.log(`[discoverRepos] selected ${repo.repoName} from ${fresh.length} candidates`);
  return { repo, candidates: fresh };
}
