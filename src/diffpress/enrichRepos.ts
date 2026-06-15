// src/diffpress/enrichRepos.ts
import { putPayload } from "./lib/payloadStore";
import type { ContentEngineState, EnrichmentPayload } from "./types";

/**
 * STUB: fetch repo documentation (Exa/Tavily) and HN/Reddit sentiment.
 * Replace this with real API calls; the return shape is the contract.
 */
async function gatherEnrichment(state: ContentEngineState): Promise<EnrichmentPayload> {
  const { repo } = state;
  return {
    repoName: repo.repoName,
    repoUrl: repo.repoUrl,
    documentation: `# ${repo.repoName}\n\n${repo.description}\n\n(stub documentation)`,
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
