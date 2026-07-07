// Service layer for the DiffPress workspace.
//
// The handoff loop (board read + resume) and the read-only article view are
// wired to the real Content Engine backend. The deploy/syndication console and
// the AI Tech Editor have no backend yet and are disabled in the UI, so their
// stubs below are retained but never invoked.

import { authedFetch } from "@/lib/authedApi";
import { fetchAuthSession } from "aws-amplify/auth";
import { AI_STREAM_URL } from "@/lib/amplify";
import type {
  ArticleResponse,
  DeployPayload,
  DeployResponse,
  DiscoveryConfig,
  DraftBody,
  DraftMeta,
  HandoffsResponse,
  PipelineData,
  ReviewNote,
  WebhookConfig,
} from "./types";


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
    published: (board.published ?? []).map((p) => ({
      id: p.repoName,
      title: p.title ?? p.repoName,
      repo: p.repoName,
      publishedAt: p.publishedAt,
      syndicatedTargets: p.syndicatedTargets ?? [],
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
/** POST to the streaming Function URL with the Cognito id token; yield parsed SSE `data:` frames. */
async function* sseStream(body: unknown): AsyncGenerator<any> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(AI_STREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`AI stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.replace(/^data:\s*/, "").trim();
      if (line) yield JSON.parse(line);
    }
  }
}

/** Run the AI review over the streaming Function URL, revealing each note as it arrives. */
export async function runReviewStream(
  repo: string,
  articleMarkdown: string,
  onNote: (n: ReviewNote) => void,
  focus?: string,
): Promise<void> {
  for await (const msg of sseStream({ action: "review", repo, articleMarkdown, focus })) {
    if (msg.error) throw new Error(msg.error);
    if (msg.note) onNote(msg.note);
    if (msg.done) return;
  }
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

/** Whole-article rewrite over the streaming Function URL. `onChunk` receives the
 *  revised markdown (the server emits it as a single chunk after parsing). */
export async function reviseArticleStream(
  repo: string,
  articleMarkdown: string,
  instruction: string,
  onChunk: (md: string) => void,
): Promise<{ title: string }> {
  let title = "";
  for await (const msg of sseStream({ action: "revise", repo, articleMarkdown, instruction })) {
    if (msg.error) throw new Error(msg.error);
    if (msg.chunk) onChunk(msg.chunk);
    if (msg.done) title = msg.title ?? "";
  }
  return { title };
}

export async function deployArticle(payload: DeployPayload): Promise<DeployResponse> {
  const res = await authedFetch("/api/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Failed to publish (${res.status})`);
  return res.json();
}

/** List the user's configured webhook targets via `GET /api/webhooks`. */
export async function listWebhooks(): Promise<WebhookConfig[]> {
  const res = await authedFetch("/api/webhooks");
  if (!res.ok) throw new Error(`Failed to load webhooks (${res.status})`);
  return (await res.json()).webhooks;
}

/** Create or update a webhook target via `POST /api/webhooks`. */
export async function saveWebhook(input: {
  id?: string;
  name: string;
  url: string;
  secret?: string;
}): Promise<WebhookConfig> {
  const res = await authedFetch("/api/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to save webhook (${res.status})`);
  return (await res.json()).webhook;
}

/** Remove a webhook target via `DELETE /api/webhooks`. */
export async function deleteWebhook(id: string): Promise<void> {
  const res = await authedFetch(`/api/webhooks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete webhook (${res.status})`);
}

/** Send a test ping to a webhook target via `POST /api/webhooks/test`. */
export async function testWebhook(input: {
  id?: string;
  url?: string;
  secret?: string;
}): Promise<{ ok: boolean; status: number }> {
  const res = await authedFetch("/api/webhooks/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to test webhook (${res.status})`);
  return res.json();
}

