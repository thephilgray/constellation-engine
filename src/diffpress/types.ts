// src/diffpress/types.ts
import type { PublishTargets } from "./lib/publish";

/**
 * Why a repo surfaced in Discovery:
 * - TRENDING — gaining stars fast over the window (new or established).
 * - NEW — recently created and gaining traction.
 * - RELEASE — shipped a release during the window.
 */
export type SignalType = "TRENDING" | "NEW" | "RELEASE";

/** A candidate repository discovered from GitHub. */
export interface RepoCandidate {
  repoName: string; // "owner/name" — the ledger partition key
  repoUrl: string;
  description: string;
  stars: number;
  language: string | null;
  pushedAt: string; // GitHub `pushed_at` ISO timestamp
  // Discovery signal (GH Archive velocity), set by discoverRepos.
  signalType?: SignalType;
  starsGained?: number; // stars gained over the discovery window
  releaseTag?: string; // tag of the release that surfaced it (RELEASE lane)
  // Interest-to-Coverage (set by discoverRepos via Tavily).
  coverageScore?: number; // 0..1, higher = more existing coverage
  coverageSources?: CoverageSource[]; // top sources, persisted for drafting
}

/** A third-party web source about a repo (or a specific release), from Tavily. */
export interface CoverageSource {
  title: string;
  url: string;
  domain: string; // registrable domain, e.g. "dev.to"
  abstract: string; // trimmed Tavily content snippet
  relevanceScore: number; // Tavily relevance score, 0..1
}

/** Enrichment payload assembled in Phase 1 and written to S3. */
export interface EnrichmentPayload {
  repoName: string;
  repoUrl: string;
  documentation: string; // Exa/Tavily stub output
  sentiment: {
    source: "hackernews" | "reddit" | "stub";
    summary: string;
    score: number; // -1..1
  }[];
  generatedAt: string; // ISO timestamp
}

/** A seed idea retrieved from (or generated for) the brain-dump index. */
export interface SeedIdea {
  id: string;
  text: string;
  score: number; // similarity score; 1 for generated stubs
}

/** Pointer to where an enrichment payload was stored in S3. */
export interface PayloadLocation {
  bucket: string;
  key: string;
}

/** The handoff data the frontend sends back to resume the workflow. */
export interface HandoffData {
  repoUrl: string;
  developerLog: string; // markdown
}

/** The state object threaded through the state machine. */
export interface ContentEngineState {
  repo: RepoCandidate;
  candidates?: RepoCandidate[];
  enrichment?: PayloadLocation;
  seedIdeas?: SeedIdea[];
  /** Article mode chosen by generateHandoff; draftArticle honors it authoritatively. */
  mode?: "narrative" | "explainer";
  /** LLM-generated handoff brief shown in the Ready-for-Dev drawer. */
  handoffPrompt?: string;
  handoff?: HandoffData;
  article?: DraftedArticle;
}

/** Output of the drafting agent. */
export interface DraftedArticle {
  title: string;
  articleMarkdown: string;
  draftedAt: string;
  /** Up to 4 Dev.to-style tags the model suggested; the editable publish seed. */
  tags?: string[];
}

export type PublicationStatus =
  | "DISCOVERED"
  | "AWAITING_HANDOFF"
  | "DRAFTING"
  | "SCHEDULED"
  | "PUBLISHED"
  | "DISMISSED";

/** An item in the PublicationLifecycle table (PK: repoName). */
export interface PublicationRecord {
  repoName: string;
  status: PublicationStatus;
  repoUrl?: string;
  taskToken?: string;
  /** LLM-generated handoff brief, persisted on the AWAITING_HANDOFF record. */
  handoffPrompt?: string;
  payloadKey?: string;
  title?: string;
  articleMarkdown?: string;
  /** Drafted Dev.to tag seed (LLM-suggested); surfaced by getArticle to seed the publish console. */
  tags?: string[];
  discoveredAt?: string;
  publishedAt?: string;
  // Scheduling fields (status === "SCHEDULED")
  scheduleAt?: string;   // ISO 8601; when the cron should publish
  targets?: PublishTargets;
  seriesLink?: string;
  /** Edited tags captured at schedule time, replayed by the cron at publish. */
  publishTags?: string[];
  // Discovery-pool fields (status === "DISCOVERED")
  description?: string;
  stars?: number;
  language?: string | null;
  pushedAt?: string;
  signalType?: SignalType; // why it surfaced (TRENDING/NEW/RELEASE)
  starsGained?: number; // stars gained over the discovery window
  releaseTag?: string; // release tag, for the RELEASE lane
  coverageScore?: number; // 0..1; projected to the board badge
  coverageSources?: CoverageSource[]; // top sources (not projected to board list)
  ttl?: number; // epoch seconds; DynamoDB TTL attribute
}
