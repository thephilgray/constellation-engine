import { describe, it, expect } from "vitest";
import {
  slugify,
  signWebhook,
  canonicalUrlFromWebhook,
  buildWebhookPayload,
  buildDevtoArticle,
  normalizeDevtoTags,
  selectedTargets,
  summarizeResults,
  parsePublishInput,
  type PublishTargets,
} from "./publish";

const allOff: PublishTargets = {
  devto: false, linkedin: false, substack: false, webhooks: [],
};

describe("slugify", () => {
  it("lowercases, hyphenates, strips punctuation", () => {
    expect(slugify("State of the Art: Helix!")).toBe("state-of-the-art-helix");
  });
  it("collapses repeated separators and trims", () => {
    expect(slugify("  Hello   World  ")).toBe("hello-world");
  });
});

describe("signWebhook", () => {
  it("produces a stable sha256= HMAC for a body+secret", () => {
    const sig = signWebhook('{"a":1}', "topsecret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Deterministic: same inputs -> same signature.
    expect(signWebhook('{"a":1}', "topsecret")).toBe(sig);
    // Different secret -> different signature.
    expect(signWebhook('{"a":1}', "other")).not.toBe(sig);
  });
});

describe("normalizeDevtoTags", () => {
  it("lowercases, strips non-alphanumerics, drops empties", () => {
    expect(normalizeDevtoTags(["React", "web-dev", "Machine Learning", "  ", "C++"]))
      .toEqual(["react", "webdev", "machinelearning", "c"]);
  });
  it("dedupes after normalizing and caps at 4", () => {
    expect(normalizeDevtoTags(["react", "React", "vue", "svelte", "angular", "solid"]))
      .toEqual(["react", "vue", "svelte", "angular"]);
  });
  it("tolerates non-string entries", () => {
    expect(normalizeDevtoTags(["ok", 5 as any, null as any, "two"]))
      .toEqual(["ok", "two"]);
  });
});

describe("buildDevtoArticle", () => {
  it("wraps the markdown with published:true, the canonical url, and tags", () => {
    const body = buildDevtoArticle({
      title: "T", markdown: "# B", canonicalUrl: "https://diffpress.com/t", tags: ["react", "webdev"],
    });
    expect(body).toEqual({
      article: {
        title: "T", body_markdown: "# B", published: true,
        canonical_url: "https://diffpress.com/t", tags: ["react", "webdev"],
      },
    });
  });
  it("normalizes tags it is given (lowercase, alnum, max 4)", () => {
    const body = buildDevtoArticle({
      title: "T", markdown: "B", canonicalUrl: "https://diffpress.com/t",
      tags: ["React", "web-dev", "Machine Learning", "Go", "Rust"],
    });
    expect(body.article.tags).toEqual(["react", "webdev", "machinelearning", "go"]);
  });
});

describe("buildWebhookPayload", () => {
  it("derives slug + canonical and carries seriesLink as series", () => {
    const p = buildWebhookPayload({
      title: "My Post", markdown: "body", repoName: "o/r",
      seriesLink: "https://x/prev", canonicalUrl: "https://diffpress.com/my-post",
      publishedAt: "2026-06-25T00:00:00.000Z",
    });
    expect(p).toEqual({
      title: "My Post", slug: "my-post", markdown: "body",
      canonicalUrl: "https://diffpress.com/my-post",
      publishedAt: "2026-06-25T00:00:00.000Z", series: "https://x/prev", repoName: "o/r",
    });
  });
  it("maps an empty seriesLink to null", () => {
    const p = buildWebhookPayload({
      title: "T", markdown: "b", repoName: "o/r", seriesLink: "",
      canonicalUrl: "https://diffpress.com/t", publishedAt: "2026-06-25T00:00:00.000Z",
    });
    expect(p.series).toBeNull();
  });
});

describe("selectedTargets", () => {
  it("returns only enabled ids", () => {
    expect(selectedTargets({ ...allOff, devto: true, webhooks: ["wh_a"] }))
      .toEqual(["devto", "wh_a"]);
  });
});

describe("summarizeResults", () => {
  it("renders per-target ok/fail with names", () => {
    expect(summarizeResults([
      { id: "devto", ok: true, detail: "" },
      { id: "wh_a", ok: false, detail: "503" },
    ])).toBe("Dev.to ✓ · wh_a ✗");
  });
});

describe("canonicalUrlFromWebhook", () => {
  it("derives origin from the first webhook url + slug", () => {
    expect(canonicalUrlFromWebhook("https://diffpress.com/x/y", "my-post")).toBe(
      "https://diffpress.com/my-post"
    );
  });
  it("returns empty string when no webhook url", () => {
    expect(canonicalUrlFromWebhook(null, "my-post")).toBe("");
  });
});

describe("selectedTargets (with dynamic webhooks)", () => {
  it("returns enabled fixed targets followed by webhook ids", () => {
    expect(
      selectedTargets({ devto: true, linkedin: false, substack: false, webhooks: ["wh_a", "wh_b"] })
    ).toEqual(["devto", "wh_a", "wh_b"]);
  });
});

describe("parsePublishInput webhooks", () => {
  const base = { requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } } };
  it("accepts a webhooks string array and rejects non-strings", () => {
    const ev = {
      ...base,
      body: JSON.stringify({
        repoName: "o/r",
        targets: { devto: false, webhooks: ["wh_a", 5, "wh_b"] },
        timing: "now",
      }),
    };
    const r = parsePublishInput(ev as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.targets.webhooks).toEqual(["wh_a", "wh_b"]);
  });
});

describe("parsePublishInput", () => {
  const ctx = (sub?: string) => ({ authorizer: sub ? { jwt: { claims: { sub } } } : undefined });
  const good = {
    repoName: "o/r", targets: { ...allOff, devto: true },
    timing: "now", scheduleAt: "", seriesLink: "",
  };
  it("rejects unauthenticated (401)", () => {
    const r = parsePublishInput({ requestContext: ctx(), body: JSON.stringify(good) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(401);
  });
  it("rejects a missing body (400)", () => {
    const r = parsePublishInput({ requestContext: ctx("u1"), body: null });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });
  it("rejects when no target is enabled (400)", () => {
    const r = parsePublishInput({ requestContext: ctx("u1"), body: JSON.stringify({ ...good, targets: allOff }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });
  it("accepts a well-formed request", () => {
    const r = parsePublishInput({ requestContext: ctx("u1"), body: JSON.stringify(good) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.repoName).toBe("o/r");
  });
  it("carries tags through, defaulting to [] when absent", () => {
    const withTags = parsePublishInput({
      requestContext: ctx("u1"),
      body: JSON.stringify({ ...good, tags: ["react", "webdev"] }),
    });
    expect(withTags.ok).toBe(true);
    if (withTags.ok) expect(withTags.value.tags).toEqual(["react", "webdev"]);

    const noTags = parsePublishInput({ requestContext: ctx("u1"), body: JSON.stringify(good) });
    expect(noTags.ok).toBe(true);
    if (noTags.ok) expect(noTags.value.tags).toEqual([]);
  });
  it("rejects scheduling with an empty scheduleAt (400)", () => {
    const r = parsePublishInput({
      requestContext: ctx("u1"),
      body: JSON.stringify({ ...good, timing: "schedule", scheduleAt: "" }),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.statusCode).toBe(400);
  });
  it("accepts scheduling with a real ISO scheduleAt", () => {
    const r = parsePublishInput({
      requestContext: ctx("u1"),
      body: JSON.stringify({ ...good, timing: "schedule", scheduleAt: "2026-07-01T09:00:00.000Z" }),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.scheduleAt).toBe("2026-07-01T09:00:00.000Z");
  });
});
