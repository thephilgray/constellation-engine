import { describe, it, expect } from "vitest";
import { buildMarkScheduledParams, buildMarkPublishedParams, BOARD_PROJECTION } from "./ledger";

const targets = {
  devto: true, diffpress: false, thephilgray: true, linkedin: false, substack: false,
};

describe("buildMarkScheduledParams", () => {
  it("sets status SCHEDULED with scheduleAt, targets, seriesLink and publishTags", () => {
    const p = buildMarkScheduledParams("T", "o/r", {
      scheduleAt: "2026-07-01T09:00:00.000Z", targets, seriesLink: "https://x/p", tags: ["react", "go"],
    });
    expect(p.TableName).toBe("T");
    expect(p.Key).toEqual({ repoName: "o/r" });
    expect(p.ExpressionAttributeValues![":scheduled"]).toBe("SCHEDULED");
    expect(p.ExpressionAttributeValues![":scheduleAt"]).toBe("2026-07-01T09:00:00.000Z");
    expect(p.ExpressionAttributeValues![":targets"]).toEqual(targets);
    expect(p.ExpressionAttributeValues![":seriesLink"]).toBe("https://x/p");
    expect(p.ExpressionAttributeValues![":publishTags"]).toEqual(["react", "go"]);
    expect(p.UpdateExpression).toContain("publishTags = :publishTags");
  });
  it("does not overwrite an already-PUBLISHED item", () => {
    const p = buildMarkScheduledParams("T", "o/r", { scheduleAt: "x", targets, seriesLink: "", tags: [] });
    expect(p.ConditionExpression).toContain("<> :published");
  });
});

describe("buildMarkPublishedParams tags", () => {
  it("persists the drafted tags seed when provided", () => {
    const p = buildMarkPublishedParams("T", "o/r", {
      title: "X", publishedAt: "2026-07-01T00:00:00.000Z", articleMarkdown: "b", tags: ["react"],
    });
    expect(p.UpdateExpression).toContain("tags = :tags");
    expect(p.ExpressionAttributeValues![":tags"]).toEqual(["react"]);
  });
  it("omits tags entirely when not provided, so the seed is never clobbered", () => {
    const p = buildMarkPublishedParams("T", "o/r", {
      title: "X", publishedAt: "2026-07-01T00:00:00.000Z", articleMarkdown: "b",
    });
    expect(p.UpdateExpression).not.toContain("tags");
    expect(p.ExpressionAttributeValues![":tags"]).toBeUndefined();
  });
});

describe("BOARD_PROJECTION", () => {
  it("includes scheduleAt so queryScheduledDue's time filter is not always-true", () => {
    // queryScheduledDue filters SCHEDULED records by (r.scheduleAt ?? "") <= nowIso.
    // Those records come from queryByStatus, which projects only BOARD_PROJECTION's
    // attributes via the status GSI. If scheduleAt is dropped from the projection,
    // every SCHEDULED record reads back as scheduleAt === undefined, the filter
    // becomes vacuously true, and the cron publishes everything immediately.
    const attrs = BOARD_PROJECTION.split(",").map((a) => a.trim());
    expect(attrs).toContain("scheduleAt");
  });
});
