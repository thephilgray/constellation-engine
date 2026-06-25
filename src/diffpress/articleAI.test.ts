import { describe, it, expect } from "vitest";
import {
  parseAIRequest,
  buildReviewPrompt,
  parseReviewResponse,
  buildReplyPrompt,
  parseReplyResponse,
  buildRevisePrompt,
} from "./articleAI";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

const eventWith = (sub: string | undefined, body: unknown): APIGatewayProxyEventV2 =>
  ({
    requestContext: sub ? { authorizer: { jwt: { claims: { sub } } } } : {},
    body: body === undefined ? undefined : JSON.stringify(body),
  } as any);

describe("parseAIRequest", () => {
  it("rejects an unauthenticated request", () => {
    const r = parseAIRequest(eventWith(undefined, { action: "review", repo: "a/b", articleMarkdown: "x" }));
    expect(r).toEqual({ ok: false, statusCode: 401, message: "Unauthorized" });
  });

  it("rejects an unknown action", () => {
    const r = parseAIRequest(eventWith("u1", { action: "bogus" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });

  it("parses a review request", () => {
    const r = parseAIRequest(eventWith("u1", { action: "review", repo: "a/b", articleMarkdown: "## Body" }));
    expect(r).toEqual({ ok: true, action: "review", repo: "a/b", articleMarkdown: "## Body" });
  });

  it("rejects a review request missing articleMarkdown", () => {
    const r = parseAIRequest(eventWith("u1", { action: "review", repo: "a/b" }));
    expect(r.ok).toBe(false);
  });

  it("carries an optional review focus when provided", () => {
    const r = parseAIRequest(
      eventWith("u1", { action: "review", repo: "a/b", articleMarkdown: "## Body", focus: "tighten the intro" }),
    );
    expect(r).toEqual({
      ok: true,
      action: "review",
      repo: "a/b",
      articleMarkdown: "## Body",
      focus: "tighten the intro",
    });
  });

  it("parses a reply request, defaulting conversation to []", () => {
    const r = parseAIRequest(
      eventWith("u1", { action: "reply", articleMarkdown: "x", note: "n", message: "m" }),
    );
    expect(r).toEqual({
      ok: true,
      action: "reply",
      articleMarkdown: "x",
      note: "n",
      conversation: [],
      message: "m",
    });
  });

  it("parses a revise request", () => {
    const r = parseAIRequest(
      eventWith("u1", { action: "revise", repo: "a/b", articleMarkdown: "x", instruction: "punchier" }),
    );
    expect(r).toEqual({
      ok: true,
      action: "revise",
      repo: "a/b",
      articleMarkdown: "x",
      instruction: "punchier",
    });
  });
});

describe("buildReviewPrompt", () => {
  it("includes the article and demands verbatim anchorText", () => {
    const p = buildReviewPrompt("## My article body");
    expect(p).toContain("## My article body");
    expect(p.toLowerCase()).toContain("verbatim");
  });

  it("weaves in a review focus when given", () => {
    const p = buildReviewPrompt("## Body", "the benchmark section");
    expect(p).toContain("the benchmark section");
    expect(p.toLowerCase()).toContain("focus");
  });

  it("omits focus framing when none is given", () => {
    expect(buildReviewPrompt("## Body").toLowerCase()).not.toContain("focus especially");
  });
});

describe("parseReviewResponse", () => {
  it("parses notes and assigns ids when missing", () => {
    const raw = JSON.stringify({
      notes: [
        { anchorText: "foo", note: "weak", replacement: "bar" },
        { id: "x", anchorText: "baz", note: "ok", replacement: "qux" },
      ],
    });
    const notes = parseReviewResponse(raw);
    expect(notes).toHaveLength(2);
    expect(notes[0].anchorText).toBe("foo");
    expect(notes[0].id).toBeTruthy();
    expect(notes[1].id).toBe("x");
  });

  it("returns [] for an empty notes array", () => {
    expect(parseReviewResponse(JSON.stringify({ notes: [] }))).toEqual([]);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseReviewResponse("not json")).toThrow(/JSON/i);
  });

  it("drops malformed notes (missing required fields)", () => {
    const raw = JSON.stringify({ notes: [{ anchorText: "foo" }, { anchorText: "a", note: "b", replacement: "c" }] });
    expect(parseReviewResponse(raw)).toHaveLength(1);
  });
});

describe("buildReplyPrompt", () => {
  it("includes the note, the prior conversation, and the user's message", () => {
    const p = buildReplyPrompt({
      articleMarkdown: "## body",
      note: "the intro is weak",
      conversation: ["editor: try this", "you: why?"],
      message: "I disagree",
    });
    expect(p).toContain("the intro is weak");
    expect(p).toContain("editor: try this");
    expect(p).toContain("I disagree");
  });
});

describe("parseReplyResponse", () => {
  it("parses a reply with an optional revised replacement", () => {
    expect(parseReplyResponse(JSON.stringify({ reply: "good point", replacement: "new" }))).toEqual({
      reply: "good point",
      replacement: "new",
    });
  });

  it("parses a reply with no replacement", () => {
    expect(parseReplyResponse(JSON.stringify({ reply: "ok" }))).toEqual({ reply: "ok" });
  });

  it("throws when reply is missing", () => {
    expect(() => parseReplyResponse(JSON.stringify({}))).toThrow(/reply/i);
  });
});

describe("buildRevisePrompt", () => {
  it("includes the instruction and the current article", () => {
    const p = buildRevisePrompt({ articleMarkdown: "## body", instruction: "make it punchier" });
    expect(p).toContain("## body");
    expect(p).toContain("make it punchier");
  });
});
