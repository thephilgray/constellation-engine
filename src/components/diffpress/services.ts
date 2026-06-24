// Service layer for the DiffPress workspace.
//
// The handoff loop (board read + resume) and the read-only article view are
// wired to the real Content Engine backend. The deploy/syndication console and
// the AI Tech Editor have no backend yet and are disabled in the UI, so their
// stubs below are retained but never invoked.

import { authedFetch } from "@/lib/authedApi";
import type {
  ArticleResponse,
  DeployPayload,
  DiscoveryConfig,
  DraftBody,
  DraftMeta,
  HandoffsResponse,
  PipelineData,
  ReviewNote,
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

/** Dismiss a board card (Discovery or Ready-for-Dev) via `POST /api/board-action`. */
export async function dismissCard(repoName: string): Promise<void> {
  const res = await authedFetch("/api/board-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoName, action: "dismiss" }),
  });
  if (!res.ok) throw new Error(`Failed to dismiss card (${res.status})`);
}

/** Re-roll a Ready-for-Dev handoff brief via `POST /api/board-action`. */
export async function regenerateHandoff(
  repoName: string,
): Promise<{ handoffPrompt: string }> {
  const res = await authedFetch("/api/board-action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repoName, action: "regenerate-handoff" }),
  });
  if (!res.ok) throw new Error(`Failed to regenerate handoff (${res.status})`);
  return res.json();
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

/** Persist edits to an existing article via `PUT /api/articles`. */
export async function saveArticle(
  repoName: string,
  articleMarkdown: string,
): Promise<void> {
  const res = await authedFetch("/api/articles", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo: repoName, articleMarkdown }),
  });
  if (!res.ok) throw new Error(`Failed to save article (${res.status})`);
}

/** List an article's versioned drafts (newest-first) via `GET /api/articles/drafts`. */
export async function listDrafts(repoName: string): Promise<DraftMeta[]> {
  const res = await authedFetch(
    `/api/articles/drafts?repo=${encodeURIComponent(repoName)}`,
  );
  if (!res.ok) throw new Error(`Failed to list drafts (${res.status})`);
  const body: { drafts: DraftMeta[] } = await res.json();
  return body.drafts;
}

/** Fetch a single draft's full body via `GET /api/articles/drafts?ts=`. */
export async function getDraft(repoName: string, ts: string): Promise<DraftBody> {
  const res = await authedFetch(
    `/api/articles/drafts?repo=${encodeURIComponent(repoName)}&ts=${encodeURIComponent(ts)}`,
  );
  if (!res.ok) throw new Error(`Failed to load draft (${res.status})`);
  return res.json();
}

/** Run the AI Tech Editor over the article via `POST /api/articles/ai`. */
export async function runReview(
  repo: string,
  articleMarkdown: string,
): Promise<ReviewNote[]> {
  const res = await authedFetch("/api/articles/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "review", repo, articleMarkdown }),
  });
  if (!res.ok) throw new Error(`Failed to run review (${res.status})`);
  const body: { notes: ReviewNote[] } = await res.json();
  return body.notes;
}

/** Push back on a single review note; the editor may revise its `replacement`. */
export async function replyToNote(input: {
  articleMarkdown: string;
  note: string;
  conversation: string[];
  message: string;
}): Promise<{ reply: string; replacement?: string }> {
  const res = await authedFetch("/api/articles/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reply", ...input }),
  });
  if (!res.ok) throw new Error(`Failed to reply to note (${res.status})`);
  return res.json();
}

/** Whole-article rewrite from a general instruction. Returns the new article. */
export async function reviseArticle(
  repo: string,
  articleMarkdown: string,
  instruction: string,
): Promise<{ title: string; articleMarkdown: string }> {
  const res = await authedFetch("/api/articles/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "revise", repo, articleMarkdown, instruction }),
  });
  if (!res.ok) throw new Error(`Failed to revise article (${res.status})`);
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

