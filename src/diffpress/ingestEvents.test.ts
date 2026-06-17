import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createAccumulator,
  accumulateEvent,
  toSignalWrites,
  archiveUrl,
  hourKey,
  targetHour,
  handler,
  type GhEvent,
} from "./ingestEvents";
import { getDiscoveryConfig } from "./lib/config";

vi.mock("./lib/config", () => ({
  getDiscoveryConfig: vi.fn().mockResolvedValue({
    engineState: "active",
    discoveryMode: "frontier",
    velocity: 6,
  }),
}));

const watch = (repo: string, actor: string): GhEvent => ({
  type: "WatchEvent",
  actor: { login: actor },
  repo: { name: repo },
  payload: { action: "started" },
});

const release = (repo: string, tag: string): GhEvent => ({
  type: "ReleaseEvent",
  repo: { name: repo },
  payload: { action: "published", release: { tag_name: tag } },
});

describe("accumulateEvent", () => {
  it("dedupes stars by actor login", () => {
    const acc = createAccumulator();
    accumulateEvent(acc, watch("a/one", "alice"));
    accumulateEvent(acc, watch("a/one", "alice")); // dup actor
    accumulateEvent(acc, watch("a/one", "bob"));
    expect(acc.stars.get("a/one")?.size).toBe(2);
  });

  it("captures the latest published release tag", () => {
    const acc = createAccumulator();
    accumulateEvent(acc, release("a/one", "v1.0.0"));
    accumulateEvent(acc, release("a/one", "v1.1.0"));
    expect(acc.releases.get("a/one")).toBe("v1.1.0");
  });

  it("ignores other event types and unpublished releases", () => {
    const acc = createAccumulator();
    accumulateEvent(acc, { type: "PushEvent", repo: { name: "a/one" } });
    accumulateEvent(acc, {
      type: "ReleaseEvent",
      repo: { name: "a/one" },
      payload: { action: "created", release: { tag_name: "v2" } },
    });
    expect(acc.stars.size).toBe(0);
    expect(acc.releases.size).toBe(0);
  });
});

describe("toSignalWrites", () => {
  const hour = new Date("2026-06-16T15:00:00.000Z");

  it("emits STAR rows only above the threshold, plus RELEASE rows", () => {
    const acc = createAccumulator();
    accumulateEvent(acc, watch("hot/repo", "a"));
    accumulateEvent(acc, watch("hot/repo", "b"));
    accumulateEvent(acc, watch("cold/repo", "c")); // 1 star < threshold 2
    accumulateEvent(acc, release("ship/repo", "v3.0.0"));

    const rows = toSignalWrites(acc, hour, 2);
    const byKey = Object.fromEntries(rows.map((r) => [r.repoName, r]));

    expect(rows).toHaveLength(2);
    expect(byKey["hot/repo"]).toMatchObject({
      signalKey: "STAR#2026-06-16-15",
      signalType: "STAR",
      count: 2,
      bucketMs: hour.getTime(),
      repoUrl: "https://github.com/hot/repo",
    });
    expect(byKey["cold/repo"]).toBeUndefined();
    expect(byKey["ship/repo"]).toMatchObject({
      signalKey: "RELEASE#2026-06-16-15",
      signalType: "RELEASE",
      releaseTag: "v3.0.0",
    });
  });
});

describe("handler", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips gracefully when the hourly file is not yet published (404)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false });
    vi.stubGlobal("fetch", fetchMock);
    const result = await handler();
    expect(result.skipped).toBe(true);
    expect(result.rows).toBe(0);
  });

  it("hard-stops without fetching when the engine is off", async () => {
    vi.mocked(getDiscoveryConfig).mockResolvedValueOnce({
      engineState: "off",
      discoveryMode: "frontier",
      velocity: 6,
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await handler();
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("archiveUrl / hourKey / targetHour", () => {
  it("builds the GH Archive URL with an unpadded hour", () => {
    expect(archiveUrl(new Date("2026-06-16T05:00:00Z"))).toBe(
      "https://data.gharchive.org/2026-06-16-5.json.gz"
    );
  });
  it("builds a sortable hour key with a padded hour", () => {
    expect(hourKey(new Date("2026-06-16T05:00:00Z"))).toBe("2026-06-16-05");
  });
  it("floors to the hour after subtracting the publish lag", () => {
    const now = Date.parse("2026-06-16T15:42:00Z");
    expect(targetHour(now, 2).toISOString()).toBe("2026-06-16T13:00:00.000Z");
  });
});
