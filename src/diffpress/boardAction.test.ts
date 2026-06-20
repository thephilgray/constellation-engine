import { describe, it, expect } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { parseBoardActionEvent, reconstructCandidate } from "./boardAction";
import type { PublicationRecord } from "./types";

function event(body: unknown, authed = true): APIGatewayProxyEventV2 {
  return {
    body: body === undefined ? undefined : JSON.stringify(body),
    requestContext: authed
      ? ({ authorizer: { jwt: { claims: { sub: "user-1" } } } } as any)
      : ({} as any),
  } as APIGatewayProxyEventV2;
}

describe("parseBoardActionEvent", () => {
  it("rejects unauthenticated requests", () => {
    const r = parseBoardActionEvent(event({ repoName: "a/b", action: "dismiss" }, false));
    expect(r).toMatchObject({ ok: false, statusCode: 401 });
  });

  it("rejects an unknown action", () => {
    const r = parseBoardActionEvent(event({ repoName: "a/b", action: "delete" }));
    expect(r).toMatchObject({ ok: false, statusCode: 400 });
  });

  it("accepts a valid dismiss request", () => {
    const r = parseBoardActionEvent(event({ repoName: "a/b", action: "dismiss" }));
    expect(r).toEqual({ ok: true, value: { repoName: "a/b", action: "dismiss" } });
  });
});

describe("reconstructCandidate", () => {
  it("maps a ledger row to a RepoCandidate with safe fallbacks", () => {
    const rec: PublicationRecord = {
      repoName: "a/b",
      status: "AWAITING_HANDOFF",
      repoUrl: "https://github.com/a/b",
      description: "desc",
      stars: 42,
      language: "Rust",
      signalType: "TRENDING",
    };
    const c = reconstructCandidate(rec);
    expect(c).toMatchObject({
      repoName: "a/b",
      repoUrl: "https://github.com/a/b",
      description: "desc",
      stars: 42,
      language: "Rust",
    });
  });

  it("defaults missing optional fields", () => {
    const c = reconstructCandidate({ repoName: "a/b", status: "AWAITING_HANDOFF" });
    expect(c.repoUrl).toBe("");
    expect(c.description).toBe("");
    expect(c.stars).toBe(0);
    expect(c.language).toBeNull();
  });
});
