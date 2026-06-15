import { describe, it, expect } from "vitest";
import {
  buildPendingPutParams,
  buildMarkPublishedParams,
  isAlreadyPublishedError,
} from "./ledger";

describe("buildPendingPutParams", () => {
  it("builds a PutCommand input for an AWAITING_HANDOFF item", () => {
    const params = buildPendingPutParams("MyTable", {
      repoName: "vercel/next.js",
      status: "AWAITING_HANDOFF",
      repoUrl: "https://github.com/vercel/next.js",
      taskToken: "tok-123",
      payloadKey: "enrichment/exec-1/vercel-next.js.json",
      discoveredAt: "2026-06-14T00:00:00.000Z",
    });
    expect(params.TableName).toBe("MyTable");
    expect(params.Item!.repoName).toBe("vercel/next.js");
    expect(params.Item!.status).toBe("AWAITING_HANDOFF");
    expect(params.Item!.taskToken).toBe("tok-123");
  });
});

describe("buildMarkPublishedParams", () => {
  it("builds a conditional UpdateCommand input keyed by repoName", () => {
    const params = buildMarkPublishedParams("MyTable", "vercel/next.js", {
      title: "Inside Next.js",
      publishedAt: "2026-06-14T01:00:00.000Z",
    });
    expect(params.TableName).toBe("MyTable");
    expect(params.Key).toEqual({ repoName: "vercel/next.js" });
    expect(params.ConditionExpression).toContain("status");
    expect(params.ExpressionAttributeValues![":published"]).toBe("PUBLISHED");
    expect(params.ExpressionAttributeValues![":title"]).toBe("Inside Next.js");
  });
});

describe("isAlreadyPublishedError", () => {
  it("returns true for a ConditionalCheckFailedException", () => {
    expect(isAlreadyPublishedError({ name: "ConditionalCheckFailedException" })).toBe(true);
  });
  it("returns false for other errors", () => {
    expect(isAlreadyPublishedError({ name: "ResourceNotFoundException" })).toBe(false);
    expect(isAlreadyPublishedError(new Error("boom"))).toBe(false);
  });
});
