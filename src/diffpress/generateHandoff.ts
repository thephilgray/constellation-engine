// src/diffpress/generateHandoff.ts
import { GoogleGenAI, Type } from "@google/genai";
import { Resource } from "sst";
import { getPayload } from "./lib/payloadStore";
import type {
  ContentEngineState,
  RepoCandidate,
  SeedIdea,
  EnrichmentPayload,
} from "./types";

const MODEL = "gemini-2.5-pro";

/** Pure: assemble the Gemini instruction that produces the handoff brief. */
export function buildMetaPrompt(input: {
  repo: RepoCandidate;
  documentation: string;
  seedIdeas: SeedIdea[];
}): string {
  const { repo, documentation, seedIdeas } = input;
  const coverage =
    (repo.coverageSources ?? [])
      .map((s) => `- "${s.title}" (${s.domain}) — ${s.abstract}`)
      .join("\n") || "(none found)";
  const seeds =
    seedIdeas.map((s) => `- ${s.text}`).join("\n") || "(none — invent an original idea)";
  return [
    `You are the assignment editor for DiffPress, a publication that covers emerging open-source projects through the lens of a real demo project built with them.`,
    ``,
    `Produce a Markdown "handoff brief" that a developer will follow to build a demo project featuring the open-source project below, and to log the build so the log becomes the first draft of an article.`,
    ``,
    `## Decide the mode first`,
    `- If this repo is a good basis for an original, NON-trivial demo project, choose "narrative".`,
    `- If it is NOT a good fit for any real demo idea (e.g. it is a library best shown by explanation, not a standalone build), choose "explainer".`,
    `Never propose a hello-world or trivial example. If the only honest demo would be trivial, choose "explainer" instead.`,
    ``,
    `## narrative mode`,
    `Propose ONE specific, real demo project that exercises this repo meaningfully. Use the author's seed ideas below as LOOSE inspiration — lean on one if it genuinely fits, otherwise invent an original idea. The demo MUST differentiate from the existing coverage listed below (find an angle those pieces miss; do not rebuild what is already written about). The brief must cover: what to build and why it is interesting; which specific repo features/APIs to exercise; and logging guidance.`,
    ``,
    `## explainer mode`,
    `A lighter brief: clone, run, and critically evaluate the repo. No standalone demo build is required.`,
    ``,
    `## Logging guidance (REQUIRED in both modes)`,
    `Instruct the developer to create a file named DIFFPRESS.md at the ROOT of the demo project repo and log there as they work. The log should capture: decisions and why; friction points, surprises, and rough edges; timings worth quoting; specific details about ${repo.repoName}; and a critical-evaluation section near the end. Frame the log as the first draft of a narrative, demo-centric article that features ${repo.repoName} as its subject.`,
    ``,
    `## Open-source project`,
    `- Name: ${repo.repoName}`,
    `- URL: ${repo.repoUrl}`,
    `- Description: ${repo.description || "(none)"}`,
    `- Primary language: ${repo.language ?? "(unknown)"}`,
    `- Stars: ${repo.stars}`,
    ``,
    `## Repo documentation (README)`,
    documentation || "(none available)",
    ``,
    `## Author's seed ideas (loose inspiration only)`,
    seeds,
    ``,
    `## Existing coverage (differentiate from these)`,
    coverage,
    ``,
    `## Output`,
    `Return a JSON object with two fields: "mode" (either "narrative" or "explainer") and "handoffMarkdown" (the full handoff brief in GitHub-flavored Markdown, beginning at a level-1 heading like "# Handoff — ${repo.repoName}").`,
  ].join("\n");
}

/** Pure: minimal boilerplate brief used when generation fails. */
export function fallbackHandoffPrompt(repoName: string): string {
  return [
    `# Handoff — ${repoName}`,
    ``,
    `Clone the repository and build a small but real demo project that uses it (avoid hello-world). If it is a poor fit for a demo, clone and critically evaluate it instead.`,
    ``,
    `## Logging`,
    `Create a \`DIFFPRESS.md\` file at the root of your demo project repo and log as you work: decisions, friction, timings, specific details about ${repoName}, and a critical evaluation near the end. This log is the first draft of the article.`,
    ``,
    `## Deliverable`,
    `Paste your demo project's GitHub URL and developer log below, then resume the workflow to draft the article.`,
  ].join("\n");
}

/** Pure: turn raw model text into { mode?, handoffPrompt }, falling back safely. */
export function resolveHandoff(
  rawText: string,
  repoName: string
): { mode?: "narrative" | "explainer"; handoffPrompt: string } {
  const text = (rawText ?? "").trim();
  if (text) {
    try {
      const obj = JSON.parse(text) as { mode?: unknown; handoffMarkdown?: unknown };
      const modeOk = obj.mode === "narrative" || obj.mode === "explainer";
      if (
        modeOk &&
        typeof obj.handoffMarkdown === "string" &&
        obj.handoffMarkdown.trim()
      ) {
        return { mode: obj.mode as "narrative" | "explainer", handoffPrompt: obj.handoffMarkdown };
      }
    } catch {
      // fall through to boilerplate
    }
  }
  console.warn(`[generateHandoff] using fallback prompt for ${repoName}`);
  return { handoffPrompt: fallbackHandoffPrompt(repoName) };
}

// Lazy init so importing this module in unit tests does not require SST Resource bindings.
let genAI: GoogleGenAI | undefined;
function getGenAI(): GoogleGenAI {
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value });
  }
  return genAI;
}

/** Thin wrapper around the Gemini structured-output call. Returns "" on any error. */
async function generateBrief(prompt: string): Promise<string> {
  try {
    const result = await getGenAI().models.generateContent({
      model: MODEL,
      contents: [{ text: prompt }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mode: { type: Type.STRING },
            handoffMarkdown: { type: Type.STRING },
          },
          required: ["mode", "handoffMarkdown"],
        },
      },
    });
    return result.text ?? "";
  } catch (err) {
    console.error(`[generateHandoff] Gemini call failed: ${(err as Error).message}`);
    return "";
  }
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  if (!state.enrichment?.key) {
    throw new Error("generateHandoff: missing enrichment payload location in state.");
  }
  const payload: EnrichmentPayload = await getPayload(state.enrichment.key);

  const prompt = buildMetaPrompt({
    repo: state.repo,
    documentation: payload.documentation,
    seedIdeas: state.seedIdeas ?? [],
  });
  const raw = await generateBrief(prompt);
  const { mode, handoffPrompt } = resolveHandoff(raw, state.repo.repoName);

  console.log(
    `[generateHandoff] ${state.repo.repoName} → mode=${mode ?? "fallback"} (${handoffPrompt.length} chars)`
  );
  return { ...state, mode, handoffPrompt };
}
