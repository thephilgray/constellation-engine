// Async service stubs for the DiffPress workspace.
//
// Each function fakes latency and returns the shape we expect from the real
// backend (API Gateway → Lambda → Step Functions). Swap the bodies for `fetch`
// calls when the endpoints exist; the signatures are intended to stay stable.

import { HANDOFFS, PIPELINE, TECH_EDITOR_NOTES } from "./data";
import type {
  DeployPayload,
  HandoffDoc,
  PipelineData,
  TechEditorNote,
} from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Load the pipeline board (Discovery → In Review). */
export async function fetchCandidates(): Promise<PipelineData> {
  await delay(280);
  return structuredClone(PIPELINE);
}

/** Fetch the local-dev handoff prompt for a "Ready for Dev" repo. */
export async function fetchHandoff(id: string): Promise<HandoffDoc | null> {
  await delay(160);
  return HANDOFFS[id] ?? null;
}

/**
 * Resume the workflow for a repo: attaches the developer log and advances the
 * card from "Ready for Dev" into "Drafting". Eventually a Step Functions
 * `SendTaskSuccess` call.
 */
export async function publishHandoff(input: {
  id: string;
  repoUrl: string;
  devLog: string;
}): Promise<{ ok: true; advancedTo: "drafting" }> {
  await delay(650);
  return { ok: true, advancedTo: "drafting" };
}

/** Deploy / syndicate the finished article. Eventually a deploy Step Function. */
export async function deployArticle(
  payload: DeployPayload,
): Promise<{ ok: true; summary: string }> {
  await delay(900);
  const names: Record<keyof DeployPayload["targets"], string> = {
    devto: "Dev.to",
    linkedin: "LinkedIn",
    substack: "Substack",
    portfolio: "Portfolio",
  };
  const on = (Object.keys(payload.targets) as (keyof typeof names)[])
    .filter((k) => payload.targets[k])
    .map((k) => names[k]);
  const summary =
    (on.length ? on.join(" · ") : "no targets") +
    " · " +
    (payload.timing === "now" ? "publishing now" : "scheduled");
  return { ok: true, summary };
}

export interface TechEditorStream {
  /** Called once per note as it "arrives" over the stream. */
  onNote: (note: TechEditorNote) => void;
  onDone?: () => void;
  onError?: (err: unknown) => void;
}

/**
 * Trigger the Marginalia AI Tech Editor. Simulates a Server-Sent Events stream:
 * the model emits notes one at a time with realistic gaps, so the margin
 * indicators can pop in progressively. Returns a cancel function (mirrors
 * `EventSource.close()`), which the caller should invoke on unmount.
 */
export function triggerTechEditor(
  articleId: string,
  { onNote, onDone, onError }: TechEditorStream,
): () => void {
  let cancelled = false;

  (async () => {
    try {
      // initial "thinking" gap before the first note lands
      await delay(600);
      for (const note of TECH_EDITOR_NOTES) {
        if (cancelled) return;
        await delay(700 + Math.random() * 700);
        if (cancelled) return;
        onNote(note);
      }
      if (!cancelled) onDone?.();
    } catch (err) {
      if (!cancelled) onError?.(err);
    }
  })();

  return () => {
    cancelled = true;
  };
}
