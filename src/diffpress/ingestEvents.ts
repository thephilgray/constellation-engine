import zlib from "node:zlib";
import readline from "node:readline";
import { Readable } from "node:stream";
import { batchPutSignals, type SignalRow } from "./lib/signals";

// GH Archive publishes one gzipped JSON file of all public GitHub events per
// hour at data.gharchive.org. We stream the file, keep only the two event types
// that carry our signals (WatchEvent = a star, ReleaseEvent = a release), and
// fold them into per-hour signal buckets. Raw bytes are never stored.

/** Hours to look back so the GH Archive file for the target hour is published. */
export const LAG_HOURS = 2;
/** Persist a repo's star bucket only if it gained at least this many that hour. */
export const STAR_HOUR_THRESHOLD = 2;
/** Signal buckets live this long; the discovery window is shorter (7 days). */
export const SIGNAL_TTL_DAYS = 8;

/** The slice of a GH Archive event we read. */
export interface GhEvent {
  type?: string;
  actor?: { login?: string } | null;
  repo?: { name?: string } | null;
  payload?: { action?: string; release?: { tag_name?: string } | null } | null;
}

/** Folded events for one hour: distinct star-actors per repo, latest release tag. */
export interface Accumulator {
  stars: Map<string, Set<string>>;
  releases: Map<string, string>;
}

export function createAccumulator(): Accumulator {
  return { stars: new Map(), releases: new Map() };
}

/** Fold one event into the accumulator. Dedupes stars by actor login. */
export function accumulateEvent(acc: Accumulator, ev: GhEvent): void {
  const repoName = ev.repo?.name;
  if (!repoName) return;

  if (ev.type === "WatchEvent") {
    const actor = ev.actor?.login ?? "";
    if (!actor) return;
    const set = acc.stars.get(repoName) ?? new Set<string>();
    set.add(actor);
    acc.stars.set(repoName, set);
    return;
  }

  if (ev.type === "ReleaseEvent" && ev.payload?.action === "published") {
    const tag = ev.payload?.release?.tag_name;
    if (tag) acc.releases.set(repoName, tag); // latest wins
  }
}

/** GH Archive filename URL for a given (UTC) hour. Hour is NOT zero-padded. */
export function archiveUrl(hour: Date): string {
  const y = hour.getUTCFullYear();
  const m = String(hour.getUTCMonth() + 1).padStart(2, "0");
  const d = String(hour.getUTCDate()).padStart(2, "0");
  return `https://data.gharchive.org/${y}-${m}-${d}-${hour.getUTCHours()}.json.gz`;
}

/** Stable, sortable SK suffix for an hour bucket (hour zero-padded). */
export function hourKey(hour: Date): string {
  const y = hour.getUTCFullYear();
  const m = String(hour.getUTCMonth() + 1).padStart(2, "0");
  const d = String(hour.getUTCDate()).padStart(2, "0");
  const h = String(hour.getUTCHours()).padStart(2, "0");
  return `${y}-${m}-${d}-${h}`;
}

/** The hour to ingest: now minus the publish lag, floored to the hour (UTC). */
export function targetHour(nowMs: number, lagHours: number = LAG_HOURS): Date {
  const d = new Date(nowMs - lagHours * 60 * 60 * 1000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Turn a folded hour into signal rows, thresholding stars to drop noise. */
export function toSignalWrites(
  acc: Accumulator,
  hour: Date,
  starThreshold: number = STAR_HOUR_THRESHOLD
): SignalRow[] {
  const bucketMs = hour.getTime();
  const key = hourKey(hour);
  const ttl = Math.floor(bucketMs / 1000) + SIGNAL_TTL_DAYS * 24 * 60 * 60;
  const rows: SignalRow[] = [];

  for (const [repoName, actors] of acc.stars) {
    if (actors.size < starThreshold) continue;
    rows.push({
      repoName,
      signalKey: `STAR#${key}`,
      signalType: "STAR",
      bucketMs,
      count: actors.size,
      repoUrl: `https://github.com/${repoName}`,
      ttl,
    });
  }

  for (const [repoName, releaseTag] of acc.releases) {
    rows.push({
      repoName,
      signalKey: `RELEASE#${key}`,
      signalType: "RELEASE",
      bucketMs,
      releaseTag,
      repoUrl: `https://github.com/${repoName}`,
      ttl,
    });
  }

  return rows;
}

export async function handler(): Promise<{
  hour: string;
  rows: number;
  skipped?: boolean;
}> {
  const hour = targetHour(Date.now());
  const url = archiveUrl(hour);

  const res = await fetch(url);
  // GH Archive sometimes publishes late; a missing file is harmless — the next
  // hourly run moves on, and one gap in a 168-hour window is noise. Skip, don't
  // throw (which would raise a spurious alarm).
  if (res.status === 404) {
    console.log(`[ingestEvents] ${hourKey(hour)}: file not published yet; skipping`);
    return { hour: hourKey(hour), rows: 0, skipped: true };
  }
  if (!res.ok || !res.body) {
    throw new Error(`[ingestEvents] fetch ${url} failed: ${res.status}`);
  }

  const gunzip = zlib.createGunzip();
  const input = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]).pipe(gunzip);
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  const acc = createAccumulator();
  for await (const line of rl) {
    if (!line) continue;
    try {
      accumulateEvent(acc, JSON.parse(line) as GhEvent);
    } catch {
      // Skip malformed lines rather than failing the whole hour.
    }
  }

  const rows = toSignalWrites(acc, hour);
  await batchPutSignals(rows);

  console.log(`[ingestEvents] ${hourKey(hour)}: wrote ${rows.length} signal rows`);
  return { hour: hourKey(hour), rows: rows.length };
}
