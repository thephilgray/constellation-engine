import { createHmac } from "node:crypto";

// Fixed (non-webhook) syndication targets. Webhooks are dynamic, by id.
export type FixedTargetId = "devto" | "linkedin" | "substack";

export interface PublishTargets {
  devto: boolean;
  linkedin: boolean;
  substack: boolean;
  webhooks: string[]; // enabled webhook config ids
}

export interface PublishInput {
  repoName: string;
  targets: PublishTargets;
  timing: "now" | "schedule";
  scheduleAt: string;
  seriesLink: string;
  tags: string[];
}

// Dev.to accepts at most 4 tags.
const MAX_DEVTO_TAGS = 4;

export interface TargetResult {
  id: string;
  ok: boolean;
  detail: string;
}

export interface WebhookPayload {
  title: string;
  slug: string;
  markdown: string;
  canonicalUrl: string;
  publishedAt: string;
  series: string | null;
  repoName: string;
}

const TARGET_NAMES: Record<string, string> = {
  devto: "Dev.to",
  linkedin: "LinkedIn",
  substack: "Substack",
};

export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function signWebhook(rawBody: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
}

/** Canonical base = origin of the first enabled webhook's URL; empty when none. */
export function canonicalUrlFromWebhook(firstWebhookUrl: string | null, slug: string): string {
  if (!firstWebhookUrl) return "";
  return `${new URL(firstWebhookUrl).origin}/${slug}`;
}

export function buildWebhookPayload(args: {
  title: string;
  markdown: string;
  repoName: string;
  seriesLink: string;
  canonicalUrl: string;
  publishedAt: string;
}): WebhookPayload {
  const slug = slugify(args.title);
  return {
    title: args.title,
    slug,
    markdown: args.markdown,
    canonicalUrl: args.canonicalUrl,
    publishedAt: args.publishedAt,
    series: args.seriesLink.trim() === "" ? null : args.seriesLink,
    repoName: args.repoName,
  };
}

/**
 * Coerce arbitrary tag input into Dev.to's accepted form: lowercase,
 * alphanumeric only (Dev.to rejects separators/spaces), de-duplicated, max 4.
 * Applied at the trust boundary so a bad tag can't 422 the whole article POST.
 */
export function normalizeDevtoTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== "string") continue;
    const tag = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length === MAX_DEVTO_TAGS) break;
  }
  return out;
}

export function buildDevtoArticle(args: {
  title: string;
  markdown: string;
  canonicalUrl: string;
  tags: string[];
}): {
  article: {
    title: string;
    body_markdown: string;
    published: true;
    canonical_url: string;
    tags: string[];
  };
} {
  return {
    article: {
      title: args.title,
      body_markdown: args.markdown,
      published: true,
      canonical_url: args.canonicalUrl,
      tags: normalizeDevtoTags(args.tags),
    },
  };
}

export function selectedTargets(t: PublishTargets): string[] {
  const fixed = (["devto", "linkedin", "substack"] as const).filter((k) => t[k]);
  return [...fixed, ...t.webhooks];
}

export function summarizeResults(results: TargetResult[]): string {
  return results
    .map((r) => `${TARGET_NAMES[r.id] ?? r.id} ${r.ok ? "✓" : "✗"}`)
    .join(" · ");
}

export function parsePublishInput(event: {
  requestContext?: any;
  body?: string | null;
}): { ok: true; value: PublishInput } | { ok: false; statusCode: number; message: string } {
  const userId = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!userId) return { ok: false, statusCode: 401, message: "Unauthorized" };
  if (!event.body) return { ok: false, statusCode: 400, message: "Missing request body" };

  let parsed: any;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body" };
  }

  const { repoName, targets, timing, scheduleAt, seriesLink, tags } = parsed ?? {};
  if (typeof repoName !== "string" || repoName.trim() === "") {
    return { ok: false, statusCode: 400, message: "repoName is required" };
  }
  if (typeof targets !== "object" || targets === null) {
    return { ok: false, statusCode: 400, message: "targets is required" };
  }
  const norm: PublishTargets = {
    devto: !!targets.devto,
    linkedin: !!targets.linkedin,
    substack: !!targets.substack,
    webhooks: Array.isArray(targets.webhooks)
      ? targets.webhooks.filter((x: unknown): x is string => typeof x === "string")
      : [],
  };
  if (!selectedTargets(norm).length) {
    return { ok: false, statusCode: 400, message: "At least one target is required" };
  }
  if (timing !== "now" && timing !== "schedule") {
    return { ok: false, statusCode: 400, message: "timing must be 'now' or 'schedule'" };
  }
  if (timing === "schedule" && (typeof scheduleAt !== "string" || scheduleAt.trim() === "")) {
    return { ok: false, statusCode: 400, message: "scheduleAt is required when scheduling" };
  }
  return {
    ok: true,
    value: {
      repoName,
      targets: norm,
      timing,
      scheduleAt: typeof scheduleAt === "string" ? scheduleAt : "",
      seriesLink: typeof seriesLink === "string" ? seriesLink : "",
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
    },
  };
}
