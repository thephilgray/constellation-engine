// src/diffpress/draftArticle.ts
import { getPayload } from "./lib/payloadStore";
import type { ContentEngineState, DraftedArticle } from "./types";

/**
 * STUB: combine enrichment docs, the repo URL, and the developer log into an article.
 * Replace the body with a real LLM call; the return shape is the contract.
 */
function composeArticle(
  docs: string,
  repoUrl: string,
  developerLog: string,
  repoName: string
): DraftedArticle {
  return {
    title: `A Critical Read of ${repoName}`,
    articleMarkdown: [
      `# A Critical Read of ${repoName}`,
      ``,
      `Source: ${repoUrl}`,
      ``,
      `## Background`,
      docs,
      ``,
      `## Developer Log`,
      developerLog,
    ].join("\n"),
    draftedAt: new Date().toISOString(),
  };
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  if (!state.enrichment?.key) {
    throw new Error("draftArticle: missing enrichment payload location in state.");
  }
  if (!state.handoff) {
    throw new Error("draftArticle: missing handoff data in state.");
  }

  const payload = await getPayload(state.enrichment.key);
  const article = composeArticle(
    payload.documentation,
    state.handoff.repoUrl,
    state.handoff.developerLog,
    state.repo.repoName
  );

  console.log(`[draftArticle] drafted "${article.title}"`);
  return { ...state, article };
}
