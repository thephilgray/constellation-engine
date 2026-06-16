// src/diffpress/draftArticle.ts
import { getPayload } from "./lib/payloadStore";
import type {
  ContentEngineState,
  DraftedArticle,
  RepoCandidate,
  EnrichmentPayload,
} from "./types";

/** Pure: assemble the full Gemini prompt from repo metadata, enrichment, and notes. */
export function buildDraftPrompt(input: {
  repo: RepoCandidate;
  enrichment: EnrichmentPayload;
  notes: string;
}): string {
  const { repo, enrichment, notes } = input;
  const sentiment =
    enrichment.sentiment
      .map((s) => `- (${s.source}, score ${s.score}) ${s.summary}`)
      .join("\n") || "- (none)";
  return [
    `You are the staff writer for DiffPress, a publication that covers emerging open-source projects through the lens of real demo projects built with them.`,
    ``,
    `Write a publishable Markdown article about the author's experience with the open-source project below.`,
    ``,
    `## Mode`,
    `Two modes are supported:`,
    `- "explainer": a neutral, informative piece about the OSS project; the author's demo is NOT the focus.`,
    `- "narrative": the story of building the author's demo project that used this OSS project; demo-centric, with the OSS project as a supporting subject.`,
    `If the author's notes contain an explicit directive (a line such as "mode: explainer" or "mode: narrative", or a natural-language instruction like "write this as a narrative about my build"), honor it.`,
    `Otherwise infer the mode from the depth of the notes: rich, detailed notes -> narrative; thin notes -> a concise explainer.`,
    `Do not manufacture opinions or filler. Include criticism or assessment only where the notes or community sentiment provide specific, substantive signal.`,
    ``,
    `## OSS project`,
    `- Name: ${repo.repoName}`,
    `- URL: ${repo.repoUrl}`,
    `- Description: ${repo.description || "(none)"}`,
    `- Stars: ${repo.stars}`,
    `- Primary language: ${repo.language ?? "(unknown)"}`,
    ``,
    `## Reference documentation`,
    enrichment.documentation || "(none)",
    ``,
    `## Community sentiment`,
    sentiment,
    ``,
    `## Author's notes (primary source — drives both content and mode)`,
    notes || "(none provided)",
    ``,
    `## Output`,
    `Return a JSON object with two fields: "title" (a concise, specific headline) and "articleMarkdown" (the full article in GitHub-flavored Markdown, beginning at a level-2 heading; do not repeat the title as an H1).`,
  ].join("\n");
}

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
