import { describe, it, expect } from "vitest";
import { parseRepoQuery } from "./getArticle";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const eventWith = (
  sub: string | undefined,
  repo: string | undefined
): APIGatewayProxyEventV2 =>
  ({
    requestContext: sub ? { authorizer: { jwt: { claims: { sub } } } } : {},
    queryStringParameters: repo === undefined ? undefined : { repo },
  } as any);

describe("parseRepoQuery", () => {
  it("rejects an unauthenticated request", () => {
    const r = parseRepoQuery(eventWith(undefined, "forge/sigil"));
    expect(r).toEqual({ ok: false, statusCode: 401, message: "Unauthorized" });
  });

  it("rejects a missing repo param", () => {
    const r = parseRepoQuery(eventWith("user-1", undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("rejects a blank repo param", () => {
    const r = parseRepoQuery(eventWith("user-1", "   "));
    expect(r.ok).toBe(false);
  });

  it("accepts an authenticated request with a repo (slash preserved)", () => {
    const r = parseRepoQuery(eventWith("user-1", "forge/sigil"));
    expect(r).toEqual({ ok: true, repo: "forge/sigil" });
  });
});
