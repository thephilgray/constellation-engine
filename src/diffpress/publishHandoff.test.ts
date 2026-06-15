import { describe, it, expect } from "vitest";
import { parseHandoffEvent } from "./publishHandoff";

function event(opts: { sub?: string; body?: unknown }) {
  return {
    requestContext: {
      authorizer: opts.sub ? { jwt: { claims: { sub: opts.sub } } } : undefined,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  } as any;
}

describe("parseHandoffEvent", () => {
  it("rejects requests with no authenticated user (401)", () => {
    const r = parseHandoffEvent(event({ body: { taskToken: "t", repoUrl: "u", developerLog: "l" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(401);
  });

  it("rejects a missing body (400)", () => {
    const r = parseHandoffEvent(event({ sub: "user-1" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("rejects when required fields are missing (400)", () => {
    const r = parseHandoffEvent(event({ sub: "user-1", body: { taskToken: "t" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("accepts a valid request", () => {
    const r = parseHandoffEvent(
      event({ sub: "user-1", body: { taskToken: "tok", repoUrl: "https://x", developerLog: "# log" } })
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.taskToken).toBe("tok");
      expect(r.value.repoUrl).toBe("https://x");
      expect(r.value.developerLog).toBe("# log");
    }
  });
});
