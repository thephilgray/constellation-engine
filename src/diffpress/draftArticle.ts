// src/diffpress/draftArticle.ts
import { GoogleGenAI, Type } from "@google/genai";
import { Resource } from "sst";
import { getPayload } from "./lib/payloadStore";
import { fetchDevNotes, assembleNotes } from "./lib/devNotes";
import { markDrafting } from "./lib/ledger";
import { sanitizeMarkdown } from "../utils";
import type {
  ContentEngineState,
  DraftedArticle,
  RepoCandidate,
  EnrichmentPayload,
} from "./types";

const MODEL = "gemini-2.5-pro";

// Lazy init so importing this module in unit tests does not require SST Resource bindings.
let genAI: GoogleGenAI | undefined;
function getGenAI(): GoogleGenAI {
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value });
  }
  return genAI;
}

/** Pure: assemble the full Gemini prompt from repo metadata, enrichment, and notes. */
export function buildDraftPrompt(input: {
  repo: RepoCandidate;
  enrichment: EnrichmentPayload;
  notes: string;
  mode?: "narrative" | "explainer";
}): string {
  const { repo, enrichment, notes, mode } = input;
  const sentiment =
    enrichment.sentiment
      .map((s) => `- (${s.source}, score ${s.score}) ${s.summary}`)
      .join("\n") || "- (none)";
  const coverage =
    (repo.coverageSources ?? [])
      .map((s) => `- "${s.title}" (${s.domain}) — ${s.abstract}`)
      .join("\n") || "(no prior coverage found)";
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
    ...(mode
      ? [``, `MODE DIRECTIVE: ${mode} — the assignment editor has already chosen this mode. Use it; do not infer a different mode from the notes.`]
      : []),
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
    `## Existing coverage (review the literature, then differentiate)`,
    `The following third-party articles already cover this subject. Orient the piece against them: reference them where useful, and find an angle they miss. Do not duplicate their framing.`,
    coverage,
    ``,
    `## Author's notes (primary source — drives both content and mode)`,
    notes || "(none provided)",
    ``,
    `## Output`,
    `Return a JSON object with three fields: "title" (a concise, specific headline), "articleMarkdown" (the full article in GitHub-flavored Markdown, beginning at a level-2 heading; do not repeat the title as an H1), and "tags" (an array of up to 4 Dev.to-style topic tags — single lowercase words, no spaces or punctuation, e.g. "react", "webdev", "rust").`,
  ].join("\n");
}

/** Pure: parse and validate the model's JSON output into title + body + tags. */
export function parseDraftResponse(rawText: string): {
  title: string;
  articleMarkdown: string;
  tags: string[];
} {
  const text = (rawText ?? "").trim();
  if (!text) {
    throw new Error("draftArticle: model returned empty output.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("draftArticle: model output was not valid JSON.");
  }
  const obj = parsed as { title?: unknown; articleMarkdown?: unknown; tags?: unknown };
  if (
    typeof obj.title !== "string" ||
    typeof obj.articleMarkdown !== "string" ||
    !obj.title.trim() ||
    !obj.articleMarkdown.trim()
  ) {
    throw new Error("draftArticle: model output missing title or articleMarkdown.");
  }
  // Tags are a best-effort seed: tolerate absence or a malformed value.
  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string" && t.trim() !== "").slice(0, 4)
    : [];
  return { title: obj.title, articleMarkdown: obj.articleMarkdown, tags };
}

/** Thin wrapper around the Gemini structured-output call. */
async function generateArticle(prompt: string): Promise<string> {
  const result = await getGenAI().models.generateContent({
    model: MODEL,
    contents: [{ text: prompt }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          articleMarkdown: { type: Type.STRING },
          tags: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ["title", "articleMarkdown", "tags"],
      },
    },
  });
  return result.text ?? "";
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  if (!state.enrichment?.key) {
    throw new Error("draftArticle: missing enrichment payload location in state.");
  }
  if (!state.handoff) {
    throw new Error("draftArticle: missing handoff data in state.");
  }

  // Surface this repo in the Drafting column while the model runs.
  await markDrafting(state.repo.repoName);

  const payload = await getPayload(state.enrichment.key);
  const fileNotes = await fetchDevNotes(state.handoff.repoUrl);
  const notes = assembleNotes(fileNotes, state.handoff.developerLog);

  const prompt = buildDraftPrompt({ repo: state.repo, enrichment: payload, notes, mode: state.mode });
  const raw = await generateArticle(prompt);
  const { title, articleMarkdown, tags } = parseDraftResponse(raw);

  const article: DraftedArticle = {
    title,
    articleMarkdown: sanitizeMarkdown(articleMarkdown),
    draftedAt: new Date().toISOString(),
    tags,
  };

  console.log(
    `[draftArticle] drafted "${article.title}" (notes source: ${fileNotes ? "file+ui" : "ui-only"})`
  );
  return { ...state, article };
}
