import { describe, it, expect } from "vitest";
import { buildMarkScheduledParams } from "./ledger";

const targets = {
  devto: true, diffpress: false, thephilgray: true, linkedin: false, substack: false,
};

describe("buildMarkScheduledParams", () => {
  it("sets status SCHEDULED with scheduleAt, targets and seriesLink", () => {
    const p = buildMarkScheduledParams("T", "o/r", {
      scheduleAt: "2026-07-01T09:00:00.000Z", targets, seriesLink: "https://x/p",
    });
    expect(p.TableName).toBe("T");
    expect(p.Key).toEqual({ repoName: "o/r" });
    expect(p.ExpressionAttributeValues![":scheduled"]).toBe("SCHEDULED");
    expect(p.ExpressionAttributeValues![":scheduleAt"]).toBe("2026-07-01T09:00:00.000Z");
    expect(p.ExpressionAttributeValues![":targets"]).toEqual(targets);
    expect(p.ExpressionAttributeValues![":seriesLink"]).toBe("https://x/p");
  });
  it("does not overwrite an already-PUBLISHED item", () => {
    const p = buildMarkScheduledParams("T", "o/r", { scheduleAt: "x", targets, seriesLink: "" });
    expect(p.ConditionExpression).toContain("<> :published");
  });
});
