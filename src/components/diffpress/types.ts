// Domain types for the DiffPress workspace. These mirror the shapes the
// eventual API (API Gateway + Step Functions) is expected to return, so the
// stubbed services in `services.ts` can be swapped for real calls 1:1.

export type ColumnId = "discovery" | "readyForDev" | "drafting" | "inReview";

/** Why a repo surfaced in Discovery (GH Archive velocity signal). */
export type SignalType = "TRENDING" | "NEW" | "RELEASE";

export interface DiscoveryCard {
  id: string;
  repo: string;
  desc: string;
  stars: number;
  language: string;
  lastUpdated: string; // ISO timestamp (GitHub pushed_at)
  /** Link to the source repo on GitHub, when known. */
  repoUrl?: string;
  /** Which Discovery lane this card belongs to. Defaults to TRENDING. */
  signalType?: SignalType;
  /** Stars gained over the discovery window (for the reason badge). */
  starsGained?: number;
  /** Release tag, when surfaced by the RELEASE lane. */
  releaseTag?: string;
  /** Existing-coverage score 0..1 (higher = more covered). Drives the chip. */
  coverageScore?: number;
}

export interface HandoffCard {
  id: string;
  repo: string;
  desc: string;
  /** The Step Functions task token needed to resume this handoff (from the API). */
  taskToken?: string;
  /** Prefill for the resume form, when the discovered repo URL is known. */
  repoUrl?: string;
  /** LLM-generated handoff brief from the backend; falls back to boilerplate if absent. */
  handoffPrompt?: string;
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
  /** Link to the source repo on GitHub, when known. */
  repoUrl?: string;
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
export type EngineState = "active" | "paused" | "off";
export type Timing = "now" | "schedule";

/** Pipeline Command Center config, round-tripped through /api/discovery-config. */
export interface DiscoveryConfig {
  engineState: EngineState;
  discoveryMode: DiscoveryMode;
  velocity: number;
}

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
    signalType?: SignalType;
    starsGained?: number;
    releaseTag?: string;
    coverageScore?: number;
  }[];
  readyForDev: {
    repoName: string;
    repoUrl?: string;
    taskToken?: string;
    discoveredAt?: string;
    handoffPrompt?: string;
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
