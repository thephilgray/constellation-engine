import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { batchGetExisting, batchPutDiscovered } from "./lib/ledger";
import { scanSignals, type SignalRow } from "./lib/signals";
import { passesQualityBar, type RepoMetadata } from "./lib/quality";
import type {
  RepoCandidate,
  ContentEngineState,
  PublicationRecord,
  SignalType,
} from "./types";

/** Discovered cards age out after this many days so the board stays small. */
const DISCOVERY_TTL_DAYS = 10;
/** Rolling window over which star velocity is measured. */
const WINDOW_DAYS = 7;
/** A repo created within this many days counts as a "new project". */
const NEW_DAYS = 30;
/** Top trending/new candidates to enrich via the GitHub API. */
const ENRICH_LIMIT = 60;
/** Released-in-window candidates to enrich (so the RELEASE lane is fed). */
const RELEASE_ENRICH_LIMIT = 40;
/** Max cards kept per lane, so a run writes at most 3 × this. */
const MAX_PER_LANE = 8;

/** Per-repo signal aggregated over the discovery window. */
export interface RepoSignal {
  repoName: string;
  repoUrl?: string;
  starsGained: number;
  releasedInWindow: boolean;
  releaseTag?: string;
}

/** Pure: drop items whose repoName already exists in the ledger (any status). */
export function dedupeByExisting<T extends { repoName: string }>(
  items: T[],
  existing: Set<string>
): T[] {
  return items.filter((i) => !existing.has(i.repoName));
}

/**
 * Pure: fold per-hour signal rows into per-repo aggregates over the trailing
 * window, summing stars and keeping the latest release tag. Sorted by stars
 * gained, descending.
 */
export function aggregateSignals(
  rows: SignalRow[],
  nowMs: number,
  windowDays: number = WINDOW_DAYS
): RepoSignal[] {
  const cutoff = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const byRepo = new Map<string, RepoSignal & { releaseAtMs: number }>();

  for (const row of rows) {
    if (row.bucketMs < cutoff) continue;
    const sig =
      byRepo.get(row.repoName) ??
      ({
        repoName: row.repoName,
        repoUrl: row.repoUrl,
        starsGained: 0,
        releasedInWindow: false,
        releaseAtMs: -1,
      } as RepoSignal & { releaseAtMs: number });

    if (row.signalType === "STAR") {
      sig.starsGained += row.count ?? 0;
    } else if (row.signalType === "RELEASE") {
      sig.releasedInWindow = true;
      if (row.bucketMs >= sig.releaseAtMs) {
        sig.releaseAtMs = row.bucketMs;
        sig.releaseTag = row.releaseTag;
      }
    }
    sig.repoUrl ??= row.repoUrl;
    byRepo.set(row.repoName, sig);
  }

  return [...byRepo.values()]
    .map(({ releaseAtMs: _drop, ...sig }) => sig)
    .sort((a, b) => b.starsGained - a.starsGained);
}

/** Pure: classify a candidate into a Discovery lane. NEW > RELEASE > TRENDING. */
export function assignLane(
  createdAt: string,
  releasedInWindow: boolean,
  nowMs: number,
  newDays: number = NEW_DAYS
): SignalType {
  const ageMs = nowMs - Date.parse(createdAt);
  if (ageMs >= 0 && ageMs <= newDays * 24 * 60 * 60 * 1000) return "NEW";
  if (releasedInWindow) return "RELEASE";
  return "TRENDING";
}

/** Pure: keep at most `maxPerLane` candidates per signal lane, preserving order. */
export function capPerLane(
  candidates: RepoCandidate[],
  maxPerLane: number = MAX_PER_LANE
): RepoCandidate[] {
  const counts = new Map<SignalType, number>();
  const out: RepoCandidate[] = [];
  for (const c of candidates) {
    const lane: SignalType = c.signalType ?? "TRENDING";
    const n = (counts.get(lane) ?? 0) + 1;
    counts.set(lane, n);
    if (n <= maxPerLane) out.push(c);
  }
  return out;
}

/** Pure: map a fresh candidate to a DISCOVERED ledger row with a TTL. */
export function toDiscoveredRecord(
  c: RepoCandidate,
  nowMs: number
): PublicationRecord {
  return {
    repoName: c.repoName,
    status: "DISCOVERED",
    repoUrl: c.repoUrl,
    description: c.description,
    stars: c.stars,
    language: c.language,
    pushedAt: c.pushedAt,
    signalType: c.signalType,
    starsGained: c.starsGained,
    releaseTag: c.releaseTag,
    discoveredAt: new Date(nowMs).toISOString(),
    ttl: Math.floor(nowMs / 1000) + DISCOVERY_TTL_DAYS * 24 * 60 * 60,
  };
}

/** Pick the candidates to enrich: top trending/new, plus top released-in-window. */
function selectForEnrichment(ranked: RepoSignal[]): RepoSignal[] {
  const byVelocity = ranked.slice(0, ENRICH_LIMIT);
  const released = ranked
    .filter((r) => r.releasedInWindow)
    .slice(0, RELEASE_ENRICH_LIMIT);
  const seen = new Set<string>();
  const selected: RepoSignal[] = [];
  for (const r of [...byVelocity, ...released]) {
    if (seen.has(r.repoName)) continue;
    seen.add(r.repoName);
    selected.push(r);
  }
  return selected;
}

export async function handler(): Promise<ContentEngineState> {
  const now = Date.now();

  // 1. Aggregate GH Archive signals into per-repo velocity over the window.
  const ranked = aggregateSignals(await scanSignals(), now);
  const selected = selectForEnrichment(ranked);

  // 2. Drop anything already in the ledger before spending GitHub API calls.
  const existing = await batchGetExisting(selected.map((r) => r.repoName));
  const fresh = dedupeByExisting(selected, existing);

  // 3. Enrich with live repo metadata and apply quality filters.
  const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
  const enriched: RepoCandidate[] = [];
  for (const sig of fresh) {
    const [owner, repo] = sig.repoName.split("/");
    if (!owner || !repo) continue;

    let data;
    try {
      ({ data } = await octokit.rest.repos.get({ owner, repo }));
    } catch {
      continue; // renamed/deleted/private — skip
    }

    const meta: RepoMetadata = {
      name: data.full_name,
      description: data.description,
      language: data.language ?? null,
      topics: data.topics ?? [],
      licenseSpdxId: data.license?.spdx_id ?? null,
      stars: data.stargazers_count,
      archived: data.archived ?? false,
      disabled: data.disabled ?? false,
    };
    if (!passesQualityBar(meta)) continue;

    const signalType = assignLane(data.created_at, sig.releasedInWindow, now);
    enriched.push({
      repoName: data.full_name,
      repoUrl: data.html_url,
      description: data.description ?? "",
      stars: data.stargazers_count,
      language: data.language ?? null,
      pushedAt: data.pushed_at ?? new Date().toISOString(),
      signalType,
      starsGained: sig.starsGained,
      releaseTag: signalType === "RELEASE" ? sig.releaseTag : undefined,
    });
  }

  if (enriched.length === 0) {
    throw new Error("No quality discovery candidates this cycle.");
  }

  // 4. Cap per lane and persist as DISCOVERED for the board.
  const laned = capPerLane(enriched);
  await batchPutDiscovered(laned.map((c) => toDiscoveredRecord(c, now)));

  // The top-ranked candidate advances into the rest of the pipeline.
  const repo = laned[0];
  console.log(
    `[discoverRepos] ${ranked.length} signals → ${laned.length} DISCOVERED; selected ${repo.repoName} (${repo.signalType})`
  );
  return { repo, candidates: laned };
}
