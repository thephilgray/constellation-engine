import { describe, it, expect } from "vitest";
import {
  buildMarkPublishedParams,
  buildMarkSyndicatedParams,
  isAlreadyPublishedError,
  buildMarkDraftingParams,
  buildMarkAwaitingParams,
  buildMarkDismissedParams,
  buildSetHandoffPromptParams,
  BOARD_PROJECTION,
} from "./ledger";

describe("buildMarkPublishedParams", () => {
  it("builds a conditional UpdateCommand input keyed by repoName", () => {
    const params = buildMarkPublishedParams("MyTable", "vercel/next.js", {
      title: "Inside Next.js",
      publishedAt: "2026-06-14T01:00:00.000Z",
      articleMarkdown: "# Inside Next.js\n\nbody",
    });
    expect(params.TableName).toBe("MyTable");
    expect(params.Key).toEqual({ repoName: "vercel/next.js" });
    expect(params.ConditionExpression).toContain("status");
    expect(params.ExpressionAttributeValues![":published"]).toBe("PUBLISHED");
    expect(params.ExpressionAttributeValues![":title"]).toBe("Inside Next.js");
  });

  it("persists the article markdown in the update", () => {
    const params = buildMarkPublishedParams("MyTable", "vercel/next.js", {
      title: "Inside Next.js",
      publishedAt: "2026-06-14T01:00:00.000Z",
      articleMarkdown: "# Inside Next.js\n\nbody",
    });
    expect(params.UpdateExpression).toContain("articleMarkdown = :article");
    expect(params.ExpressionAttributeValues![":article"]).toBe(
      "# Inside Next.js\n\nbody"
    );
  });
});

describe("buildMarkSyndicatedParams", () => {
  it("persists the deduped union of published targets and the SYNDICATED status", () => {
    const params = buildMarkSyndicatedParams("MyTable", "owner/repo", {
      title: "T",
      publishedAt: "2026-06-27T01:00:00.000Z",
      articleMarkdown: "# T",
      syndicatedTargets: ["devto", "wh-1"],
    });
    expect(params.ExpressionAttributeValues![":syndicated"]).toBe("SYNDICATED");
    expect(params.ExpressionAttributeValues![":targets"]).toEqual(["devto", "wh-1"]);
    expect(params.UpdateExpression).toContain("syndicatedTargets = :targets");
    // No condition: re-publishing to add a target must be allowed.
    expect(params.ConditionExpression).toBeUndefined();
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

describe("buildMarkDraftingParams", () => {
  it("builds a conditional UpdateCommand flipping status to DRAFTING", () => {
    const params = buildMarkDraftingParams("MyTable", "vercel/next.js");
    expect(params.TableName).toBe("MyTable");
    expect(params.Key).toEqual({ repoName: "vercel/next.js" });
    expect(params.ExpressionAttributeValues![":drafting"]).toBe("DRAFTING");
    // Do not resurrect a published item.
    expect(params.ConditionExpression).toContain(":published");
  });
});

describe("buildMarkAwaitingParams", () => {
  it("builds an UpdateCommand carrying taskToken + payloadKey", () => {
    const params = buildMarkAwaitingParams("MyTable", "vercel/next.js", {
      repoUrl: "https://github.com/vercel/next.js",
      taskToken: "tok-9",
      payloadKey: "enrichment/exec-1/vercel-next.js.json",
    });
    expect(params.Key).toEqual({ repoName: "vercel/next.js" });
    expect(params.ExpressionAttributeValues![":awaiting"]).toBe("AWAITING_HANDOFF");
    expect(params.ExpressionAttributeValues![":taskToken"]).toBe("tok-9");
    expect(params.ExpressionAttributeValues![":payloadKey"]).toBe(
      "enrichment/exec-1/vercel-next.js.json"
    );
    expect(params.UpdateExpression).toContain("taskToken = :taskToken");
  });

  it("persists handoffPrompt when provided", () => {
    const params = buildMarkAwaitingParams("table", "acme/widget", {
      repoUrl: "https://github.com/acme/widget",
      taskToken: "tok",
      handoffPrompt: "# Handoff — acme/widget",
    });
    expect(params.UpdateExpression).toContain("handoffPrompt = :handoffPrompt");
    expect(params.ExpressionAttributeValues?.[":handoffPrompt"]).toBe("# Handoff — acme/widget");
  });

  it("stores null handoffPrompt when omitted", () => {
    const params = buildMarkAwaitingParams("table", "acme/widget", {
      repoUrl: "https://github.com/acme/widget",
      taskToken: "tok",
    });
    expect(params.ExpressionAttributeValues?.[":handoffPrompt"]).toBeNull();
  });
});

describe("buildMarkDismissedParams", () => {
  it("flips status to DISMISSED, guarding against PUBLISHED", () => {
    const params = buildMarkDismissedParams("tbl", "owner/repo");
    expect(params.TableName).toBe("tbl");
    expect(params.Key).toEqual({ repoName: "owner/repo" });
    expect(params.UpdateExpression).toBe("SET #status = :dismissed");
    expect(params.ConditionExpression).toBe(
      "attribute_not_exists(#status) OR #status <> :published",
    );
    expect(params.ExpressionAttributeValues).toMatchObject({
      ":dismissed": "DISMISSED",
      ":published": "PUBLISHED",
    });
  });
});

describe("buildSetHandoffPromptParams", () => {
  it("sets handoffPrompt + mode only on an AWAITING_HANDOFF row", () => {
    const params = buildSetHandoffPromptParams("tbl", "owner/repo", {
      handoffPrompt: "# new brief",
      mode: "narrative",
    });
    expect(params.UpdateExpression).toBe(
      "SET handoffPrompt = :handoffPrompt, #mode = :mode",
    );
    expect(params.ConditionExpression).toBe("#status = :awaiting");
    expect(params.ExpressionAttributeNames).toMatchObject({
      "#status": "status",
      "#mode": "mode",
    });
    expect(params.ExpressionAttributeValues).toMatchObject({
      ":handoffPrompt": "# new brief",
      ":mode": "narrative",
      ":awaiting": "AWAITING_HANDOFF",
    });
  });

  it("stores null mode when omitted", () => {
    const params = buildSetHandoffPromptParams("tbl", "owner/repo", {
      handoffPrompt: "# brief",
    });
    expect(params.ExpressionAttributeValues?.[":mode"]).toBeNull();
  });
});

describe("BOARD_PROJECTION", () => {
  it("includes handoffPrompt so AWAITING_HANDOFF items surface their prompt", () => {
    expect(BOARD_PROJECTION).toContain("handoffPrompt");
  });

  it("includes critical board fields: taskToken and coverageScore", () => {
    expect(BOARD_PROJECTION).toContain("taskToken");
    expect(BOARD_PROJECTION).toContain("coverageScore");
  });
});
