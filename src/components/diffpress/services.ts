// Service layer for the DiffPress workspace.
//
// The handoff loop (board read + resume) and the read-only article view are
// wired to the real Content Engine backend. The deploy/syndication console and
// the AI Tech Editor have no backend yet and are disabled in the UI, so their
// stubs below are retained but never invoked.

import { authedFetch } from "@/lib/authedApi";
import { TECH_EDITOR_NOTES } from "./data";
import type {
  ArticleResponse,
  DeployPayload,
  DiscoveryConfig,
  HandoffsResponse,
  PipelineData,
  TechEditorNote,
} from "./types";

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Load the pipeline board. All four columns come from the ledger via
 * `GET /api/handoffs` (status GSI); the UI never queries GitHub directly.
 */
export async function fetchCandidates(): Promise<PipelineData> {
  const res = await authedFetch("/api/handoffs");
  if (!res.ok) throw new Error(`Failed to load handoffs (${res.status})`);
  const board: HandoffsResponse = await res.json();
  return {
    discovery: board.discovered.map((d) => ({
      id: d.repoName,
      repo: d.repoName,
      desc: d.description ?? "",
      stars: d.stars ?? 0,
      // API sends null for repos with no detected language; normalize to "".
      language: d.language ?? "",
      lastUpdated: d.pushedAt ?? "",
      repoUrl: d.repoUrl,
      signalType: d.signalType,
      starsGained: d.starsGained,
      releaseTag: d.releaseTag,
      coverageScore: d.coverageScore,
    })),
    drafting: board.drafting.map((d) => ({
      id: d.repoName,
      repo: d.repoName,
      desc: d.description ?? "Drafting in progress.",
    })),
    readyForDev: board.readyForDev.map((h) => ({
      id: h.repoName,
      repo: h.repoName,
      desc: "Ready for a local-dev pass before drafting.",
      taskToken: h.taskToken,
      repoUrl: h.repoUrl,
      handoffPrompt: h.handoffPrompt,
    })),
    inReview: board.inReview.map((r) => ({
      id: r.repoName,
      title: r.title ?? r.repoName,
      repo: r.repoName,
      editable: true,
    })),
  };
}

/**
 * Resume the paused workflow via `POST /api/publish-handoff` (Step Functions
 * `SendTaskSuccess`). Needs the `taskToken` captured from the board.
 */
export async function publishHandoff(input: {
  taskToken: string;
  repoUrl: string;
  devLog: string;
}): Promise<void> {
  const res = await authedFetch("/api/publish-handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      taskToken: input.taskToken,
      repoUrl: input.repoUrl,
      developerLog: input.devLog,
    }),
  });
  if (!res.ok) throw new Error(`Failed to resume workflow (${res.status})`);
}

/** Load the Pipeline Command Center config from the backend. */
export async function fetchDiscoveryConfig(): Promise<DiscoveryConfig> {
  const res = await authedFetch("/api/discovery-config");
  if (!res.ok) throw new Error(`Failed to load discovery config (${res.status})`);
  return res.json();
}

/** Persist a Command Center config change. */
export async function saveDiscoveryConfig(cfg: DiscoveryConfig): Promise<void> {
  const res = await authedFetch("/api/discovery-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cfg),
  });
  if (!res.ok) throw new Error(`Failed to save discovery config (${res.status})`);
}

/** Fetch a published article's markdown for the read-only In-Review view. */
export async function fetchArticle(repoName: string): Promise<ArticleResponse> {
  const res = await authedFetch(`/api/articles?repo=${encodeURIComponent(repoName)}`);
  if (!res.ok) throw new Error(`Failed to load article (${res.status})`);
  return res.json();
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
