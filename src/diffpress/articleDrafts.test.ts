import { describe, it, expect } from "vitest";
import { parseDraftsQuery } from "./articleDrafts";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const eventWith = (
  sub: string | undefined,
  params: Record<string, string> | undefined
): APIGatewayProxyEventV2 =>
  ({
    requestContext: sub ? { authorizer: { jwt: { claims: { sub } } } } : {},
    queryStringParameters: params,
  } as any);

describe("parseDraftsQuery", () => {
  it("rejects an unauthenticated request", () => {
    const r = parseDraftsQuery(eventWith(undefined, { repo: "a/b" }));
    expect(r).toEqual({ ok: false, statusCode: 401, message: "Unauthorized" });
  });

  it("rejects a missing repo param", () => {
    const r = parseDraftsQuery(eventWith("u1", undefined));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("parses a list request (no ts)", () => {
    const r = parseDraftsQuery(eventWith("u1", { repo: "forge/sigil" }));
    expect(r).toEqual({ ok: true, repo: "forge/sigil", ts: undefined });
  });

  it("parses a fetch request (with ts)", () => {
    const r = parseDraftsQuery(
      eventWith("u1", { repo: "forge/sigil", ts: "2026-06-23T21:00:00.000Z" })
    );
    expect(r).toEqual({ ok: true, repo: "forge/sigil", ts: "2026-06-23T21:00:00.000Z" });
  });
});
