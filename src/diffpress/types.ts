// src/diffpress/types.ts

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
  handoff?: HandoffData;
  article?: DraftedArticle;
}

/** Output of the drafting agent. */
export interface DraftedArticle {
  title: string;
  articleMarkdown: string;
  draftedAt: string;
}

export type PublicationStatus =
  | "DISCOVERED"
  | "AWAITING_HANDOFF"
  | "DRAFTING"
  | "PUBLISHED";

/** An item in the PublicationLifecycle table (PK: repoName). */
export interface PublicationRecord {
  repoName: string;
  status: PublicationStatus;
  repoUrl?: string;
  taskToken?: string;
  payloadKey?: string;
  title?: string;
  articleMarkdown?: string;
  discoveredAt?: string;
  publishedAt?: string;
  // Discovery-pool fields (status === "DISCOVERED")
  description?: string;
  stars?: number;
  language?: string | null;
  pushedAt?: string;
  signalType?: SignalType; // why it surfaced (TRENDING/NEW/RELEASE)
  starsGained?: number; // stars gained over the discovery window
  releaseTag?: string; // release tag, for the RELEASE lane
  ttl?: number; // epoch seconds; DynamoDB TTL attribute
}
