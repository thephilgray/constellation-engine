import { markPublished } from "./lib/ledger";
import type { ContentEngineState } from "./types";

export async function handler(
  state: ContentEngineState
): Promise<{ repoName: string; status: "PUBLISHED" }> {
  if (!state.article) {
    throw new Error("recordPublication: missing drafted article in state.");
  }

  await markPublished(state.repo.repoName, {
    title: state.article.title,
    publishedAt: new Date().toISOString(),
  });

  console.log(`[recordPublication] ledger updated: ${state.repo.repoName} -> PUBLISHED`);
  return { repoName: state.repo.repoName, status: "PUBLISHED" };
}
