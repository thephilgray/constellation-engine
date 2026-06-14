// Domain types for the DiffPress workspace. These mirror the shapes the
// eventual API (API Gateway + Step Functions) is expected to return, so the
// stubbed services in `services.ts` can be swapped for real calls 1:1.

export type ColumnId = "discovery" | "readyForDev" | "drafting" | "inReview";

export interface DiscoveryCard {
  id: string;
  repo: string;
  desc: string;
  starsDelta: string; // e.g. "+2.1k"
  coverage: string; // e.g. "0.82"
}

export interface HandoffCard {
  id: string;
  repo: string;
  desc: string;
}

export interface DraftingCard {
  id: string;
  repo: string;
  desc: string;
  stage: string; // e.g. "model pass 2 / 3"
  progress: number; // 0..1 (drives the indeterminate-ish bar width)
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
