// Domain types for the DiffPress workspace. These mirror the shapes the
// eventual API (API Gateway + Step Functions) is expected to return, so the
// stubbed services in `services.ts` can be swapped for real calls 1:1.

export type ColumnId = "discovery" | "readyForDev" | "drafting" | "inReview";

export interface DiscoveryCard {
  id: string;
  repo: string;
  desc: string;
  stars: number;
  language: string;
  lastUpdated: string; // ISO timestamp (GitHub pushed_at)
}

export interface HandoffCard {
  id: string;
  repo: string;
  desc: string;
  /** The Step Functions task token needed to resume this handoff (from the API). */
  taskToken?: string;
  /** Prefill for the resume form, when the discovered repo URL is known. */
  repoUrl?: string;
}

export interface DraftingCard {
  id: string;
  repo: string;
  desc: string;
}

export interface ReviewCard {
  id: string;
  title: string;
  repo: string;
  /** When present, the card opens the editor; otherwise it's awaiting an editor. */
  editable: boolean;
}

export interface PipelineData {
  discovery: DiscoveryCard[];
  readyForDev: HandoffCard[];
  drafting: DraftingCard[];
  inReview: ReviewCard[];
}

/** A handoff prompt + setup for a repo that is ready for local dev. */
export interface HandoffDoc {
  id: string;
  name: string;
  handoff: string;
}

/** A single marginalia note streamed from the AI Tech Editor (SSE). */
export interface TechEditorNote {
  id: string; // n1..n4
  note: string; // the editorial rationale
  diff: DiffLine[]; // the suggested change
}

export interface DiffLine {
  kind: "context" | "remove" | "add";
  text: string;
}

export type DiscoveryMode = "frontier" | "balanced" | "ecosystem";
export type Timing = "now" | "schedule";

export interface SyndicationTargets {
  devto: boolean;
  linkedin: boolean;
  substack: boolean;
  portfolio: boolean;
}

export interface DeployPayload {
  articleId: string;
  targets: SyndicationTargets;
  timing: Timing;
  scheduleAt: string;
  seriesLink: string;
}

// ---- API response shapes (GET /api/handoffs, GET /api/articles) ----

export interface HandoffsResponse {
  discovered: {
    repoName: string;
    repoUrl?: string;
    description?: string;
    stars?: number;
    language?: string | null;
    pushedAt?: string;
  }[];
  readyForDev: {
    repoName: string;
    repoUrl?: string;
    taskToken?: string;
    discoveredAt?: string;
  }[];
  drafting: {
    repoName: string;
    description?: string;
  }[];
  inReview: {
    repoName: string;
    title?: string;
    publishedAt?: string;
  }[];
}

export interface ArticleResponse {
  repoName: string;
  title: string;
  articleMarkdown: string;
  publishedAt?: string;
  status: string;
}
