import { createHmac } from "node:crypto";

export type TargetId = "devto" | "diffpress" | "thephilgray" | "linkedin" | "substack";

export interface PublishTargets {
  devto: boolean;
  diffpress: boolean;
  thephilgray: boolean;
  linkedin: boolean;
  substack: boolean;
}

export interface PublishInput {
  repoName: string;
  targets: PublishTargets;
  timing: "now" | "schedule";
  scheduleAt: string;
  seriesLink: string;
}

export interface TargetResult {
  id: TargetId;
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

const TARGET_NAMES: Record<TargetId, string> = {
  devto: "Dev.to",
  diffpress: "diffpress.com",
  thephilgray: "thephilgray.com",
  linkedin: "LinkedIn",
  substack: "Substack",
};

// Own-domain webhook targets and their canonical bases.
const DOMAIN_BASE: Record<"diffpress" | "thephilgray", string> = {
  diffpress: "https://diffpress.com",
  thephilgray: "https://thephilgray.com",
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

export function canonicalUrlFor(targets: PublishTargets, slug: string): string {
  const domains = (["diffpress", "thephilgray"] as const).filter((d) => targets[d]);
  const base = domains.length === 1 ? DOMAIN_BASE[domains[0]] : DOMAIN_BASE.diffpress;
  return `${base}/${slug}`;
}

export function buildWebhookPayload(args: {
  title: string;
  markdown: string;
  repoName: string;
  seriesLink: string;
  targets: PublishTargets;
  publishedAt: string;
}): WebhookPayload {
  const slug = slugify(args.title);
  return {
    title: args.title,
    slug,
    markdown: args.markdown,
    canonicalUrl: canonicalUrlFor(args.targets, slug),
    publishedAt: args.publishedAt,
    series: args.seriesLink.trim() === "" ? null : args.seriesLink,
    repoName: args.repoName,
  };
}

export function buildDevtoArticle(args: {
  title: string;
  markdown: string;
  canonicalUrl: string;
}): { article: { title: string; body_markdown: string; published: true; canonical_url: string } } {
  return {
    article: {
      title: args.title,
      body_markdown: args.markdown,
      published: true,
      canonical_url: args.canonicalUrl,
    },
  };
}

export function selectedTargets(targets: PublishTargets): TargetId[] {
  return (Object.keys(targets) as TargetId[]).filter((id) => targets[id]);
}

export function summarizeResults(results: TargetResult[]): string {
  return results
    .map((r) => `${TARGET_NAMES[r.id]} ${r.ok ? "✓" : "✗"}`)
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

  const { repoName, targets, timing, scheduleAt, seriesLink } = parsed ?? {};
  if (typeof repoName !== "string" || repoName.trim() === "") {
    return { ok: false, statusCode: 400, message: "repoName is required" };
  }
  if (typeof targets !== "object" || targets === null) {
    return { ok: false, statusCode: 400, message: "targets is required" };
  }
  const norm: PublishTargets = {
    devto: !!targets.devto,
    diffpress: !!targets.diffpress,
    thephilgray: !!targets.thephilgray,
    linkedin: !!targets.linkedin,
    substack: !!targets.substack,
  };
  if (!selectedTargets(norm).length) {
    return { ok: false, statusCode: 400, message: "At least one target is required" };
  }
  if (timing !== "now" && timing !== "schedule") {
    return { ok: false, statusCode: 400, message: "timing must be 'now' or 'schedule'" };
  }
  return {
    ok: true,
    value: {
      repoName,
      targets: norm,
      timing,
      scheduleAt: typeof scheduleAt === "string" ? scheduleAt : "",
      seriesLink: typeof seriesLink === "string" ? seriesLink : "",
    },
  };
}
