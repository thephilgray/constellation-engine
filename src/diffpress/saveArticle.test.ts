import { describe, it, expect } from "vitest";
import { parseSaveArticle } from "./saveArticle";
import { buildSaveArticleParams } from "./lib/ledger";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const eventWith = (sub: string | undefined, body: unknown): APIGatewayProxyEventV2 =>
  ({
    requestContext: sub ? { authorizer: { jwt: { claims: { sub } } } } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  } as any);

describe("parseSaveArticle", () => {
  it("rejects an unauthenticated request", () => {
    const r = parseSaveArticle(eventWith(undefined, { repo: "a/b", articleMarkdown: "x" }));
    expect(r).toEqual({ ok: false, statusCode: 401, message: "Unauthorized" });
  });

  it("rejects a missing repo", () => {
    const r = parseSaveArticle(eventWith("u1", { articleMarkdown: "x" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("rejects a missing articleMarkdown", () => {
    const r = parseSaveArticle(eventWith("u1", { repo: "a/b" }));
    expect(r.ok).toBe(false);
  });

  it("accepts a valid body (slash preserved, empty markdown allowed)", () => {
    const r = parseSaveArticle(eventWith("u1", { repo: "forge/sigil", articleMarkdown: "" }));
    expect(r).toEqual({ ok: true, repo: "forge/sigil", articleMarkdown: "", title: undefined });
  });
});

describe("buildSaveArticleParams", () => {
  it("only sets articleMarkdown when no title given, guarded to existing items", () => {
    const p = buildSaveArticleParams("T", "a/b", { articleMarkdown: "hi" });
    expect(p.UpdateExpression).toBe("SET articleMarkdown = :article");
    expect(p.ConditionExpression).toBe("attribute_exists(repoName)");
    expect(p.ExpressionAttributeValues).toEqual({ ":article": "hi" });
  });

  it("also sets title when provided", () => {
    const p = buildSaveArticleParams("T", "a/b", { articleMarkdown: "hi", title: "T2" });
    expect(p.UpdateExpression).toBe("SET articleMarkdown = :article, title = :title");
    expect(p.ExpressionAttributeValues).toEqual({ ":article": "hi", ":title": "T2" });
  });
});
