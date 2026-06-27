import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getByRepo, markPublished, markScheduled } from "./lib/ledger";
import type { PublicationRecord } from "./types";
import {
  parsePublishInput,
  summarizeResults,
  buildWebhookPayload,
  buildDevtoArticle,
  canonicalUrlFromWebhook,
  signWebhook,
  slugify,
  type PublishTargets,
  type TargetResult,
} from "./lib/publish";
import { listWebhooks, getWebhookSecret, type WebhookConfig } from "./lib/webhooks";

async function postDevto(
  title: string,
  markdown: string,
  canonicalUrl: string,
  tags: string[]
): Promise<TargetResult> {
  try {
    const res = await fetch("https://dev.to/api/articles", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": Resource.DEVTO_API_KEY.value,
      },
      body: JSON.stringify(buildDevtoArticle({ title, markdown, canonicalUrl, tags })),
    });
    if (!res.ok) {
      return { id: "devto", ok: false, detail: `HTTP ${res.status}` };
    }
    return { id: "devto", ok: true, detail: "published" };
  } catch (err: any) {
    return { id: "devto", ok: false, detail: err?.message ?? "request failed" };
  }
}

async function postWebhook(
  cfg: WebhookConfig,
  secret: string,
  record: PublicationRecord,
  seriesLink: string,
  canonicalUrl: string
): Promise<TargetResult> {
  try {
    const rawBody = JSON.stringify(
      buildWebhookPayload({
        title: record.title ?? "",
        markdown: record.articleMarkdown ?? "",
        repoName: record.repoName,
        seriesLink,
        canonicalUrl,
        publishedAt: new Date().toISOString(),
      })
    );
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DiffPress-Signature": signWebhook(rawBody, secret),
      },
      body: rawBody,
    });
    if (!res.ok) return { id: cfg.id, ok: false, detail: `HTTP ${res.status}` };
    return { id: cfg.id, ok: true, detail: "delivered" };
  } catch (err: any) {
    return { id: cfg.id, ok: false, detail: err?.message ?? "request failed" };
  }
}

/** Fan out to every enabled target. Shared by the handler and the scheduled cron. */
export async function publishNow(
  record: PublicationRecord,
  targets: PublishTargets,
  seriesLink: string,
  tags: string[]
): Promise<{ results: TargetResult[]; summary: string }> {
  const allWebhooks = await listWebhooks();
  const enabled = targets.webhooks
    .map((id) => allWebhooks.find((w) => w.id === id))
    .filter((w): w is WebhookConfig => !!w);
  const canonicalUrl = canonicalUrlFromWebhook(enabled[0]?.url ?? null, slugify(record.title ?? ""));

  const jobs: Promise<TargetResult>[] = [];
  if (targets.devto) {
    jobs.push(postDevto(record.title ?? "", record.articleMarkdown ?? "", canonicalUrl, tags));
  }
  for (const id of ["linkedin", "substack"] as const) {
    if (targets[id]) jobs.push(Promise.resolve({ id, ok: false, detail: "not supported" }));
  }
  for (const cfg of enabled) {
    jobs.push(
      getWebhookSecret(cfg.id).then((secret) =>
        secret
          ? postWebhook(cfg, secret, record, seriesLink, canonicalUrl)
          : ({ id: cfg.id, ok: false, detail: "not configured" } as TargetResult)
      )
    );
  }
  const results = await Promise.all(jobs);

  if (results.some((r) => r.ok)) {
    await markPublished(record.repoName, {
      title: record.title ?? "",
      publishedAt: new Date().toISOString(),
      articleMarkdown: record.articleMarkdown ?? "",
    });
  }
  return { results, summary: summarizeResults(results) };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parsePublishInput(event as any);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: JSON.stringify({ message: parsed.message }) };
  }
  const { repoName, targets, timing, scheduleAt, seriesLink, tags } = parsed.value;

  try {
    const record = await getByRepo(repoName);
    if (!record || !record.articleMarkdown) {
      return { statusCode: 404, body: JSON.stringify({ message: "Article not found." }) };
    }

    if (timing === "schedule") {
      await markScheduled(repoName, { scheduleAt, targets, seriesLink, tags });
      return {
        statusCode: 202,
        body: JSON.stringify({ scheduled: true, summary: `Scheduled for ${scheduleAt}` }),
      };
    }

    const { results, summary } = await publishNow(record, targets, seriesLink, tags);
    return { statusCode: 200, body: JSON.stringify({ scheduled: false, results, summary }) };
  } catch (error: any) {
    console.error("[publishArticle] failed:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to publish article." }) };
  }
}
