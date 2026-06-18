// src/diffpress/enrichRepos.ts
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { putPayload } from "./lib/payloadStore";
import type { ContentEngineState, EnrichmentPayload } from "./types";

/** Max README characters kept in the enrichment payload (bounds prompt size/cost). */
export const README_CHAR_CAP = 8000;

/** Pure: compose the documentation field from the (optional) README, else description-only. */
export function buildDocumentation(
  repoName: string,
  description: string,
  readme: string | null
): string {
  const body = (readme ?? "").trim();
  if (!body) {
    return `# ${repoName}\n\n${description}`;
  }
  if (body.length > README_CHAR_CAP) {
    return `${body.slice(0, README_CHAR_CAP)}\n\n…[truncated]`;
  }
  return body;
}

/** Fetch the repo README (decoded). Returns null on missing file / non-repo / any error. */
async function fetchReadme(repoName: string): Promise<string | null> {
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) return null;
  try {
    const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
    const res = await octokit.rest.repos.getReadme({ owner, repo });
    const data = res.data as { content?: string; encoding?: string };
    if (!data.content) return null;
    const encoding = (data.encoding as BufferEncoding) ?? "base64";
    return Buffer.from(data.content, encoding).toString("utf-8");
  } catch (err) {
    console.warn(`[enrichRepos] no README for ${repoName}: ${(err as Error).message}`);
    return null;
  }
}

async function gatherEnrichment(state: ContentEngineState): Promise<EnrichmentPayload> {
  const { repo } = state;
  const readme = await fetchReadme(repo.repoName);
  return {
    repoName: repo.repoName,
    repoUrl: repo.repoUrl,
    documentation: buildDocumentation(repo.repoName, repo.description, readme),
    // STUB: HN/Reddit sentiment is still a placeholder; out of scope here.
    sentiment: [
      { source: "stub", summary: "Placeholder sentiment summary.", score: 0 },
    ],
    generatedAt: new Date().toISOString(),
  };
}

/** S3 key for an enrichment payload; slashes in repoName are flattened. */
function payloadKey(repoName: string): string {
  const safe = repoName.replace(/\//g, "-");
  return `enrichment/${Date.now()}/${safe}.json`;
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  const payload = await gatherEnrichment(state);
  const location = await putPayload(payloadKey(state.repo.repoName), payload);
  console.log(`[enrichRepos] wrote payload to s3://${location.bucket}/${location.key}`);
  return { ...state, enrichment: location };
}
