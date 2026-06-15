// src/diffpress/seedIdeas.ts
import { getEmbedding, queryPinecone } from "../utils";
import type { ContentEngineState, SeedIdea } from "./types";

const BRAIN_DUMP_INDEX = "brain-dump";

/** STUB: generate seed ideas when the index returns nothing. */
function generateSeedIdeas(state: ContentEngineState): SeedIdea[] {
  return [
    {
      id: `gen-${Date.now()}`,
      text: `Why ${state.repo.repoName} matters for ${state.repo.language ?? "developers"}.`,
      score: 1,
    },
  ];
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  const queryText = `${state.repo.repoName}: ${state.repo.description}`;
  const vector = await getEmbedding(queryText);
  const results = await queryPinecone(BRAIN_DUMP_INDEX, vector, 5);

  let seedIdeas: SeedIdea[] = (results.matches ?? []).map((m) => ({
    id: m.id,
    text: String(m.metadata?.text ?? m.metadata?.title ?? ""),
    score: m.score ?? 0,
  }));

  if (seedIdeas.length === 0) {
    console.log("[seedIdeas] no matches in brain-dump; generating fallback ideas");
    seedIdeas = generateSeedIdeas(state);
  }

  return { ...state, seedIdeas };
}
