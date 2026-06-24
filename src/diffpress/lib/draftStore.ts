// src/diffpress/lib/draftStore.ts
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Resource } from "sst";

const s3 = new S3Client({});

function bucketName(): string {
  return (Resource as unknown as { ContentPayloadBucket: { name: string } }).ContentPayloadBucket.name;
}

export type DraftBody = { savedAt: string; title?: string; articleMarkdown: string };
export type DraftMeta = { ts: string };

/** Pure: the S3 key for a repo's draft at a given ISO timestamp. */
export function draftKey(repoName: string, ts: string): string {
  return `drafts/${repoName}/${ts}.json`;
}

/** Pure: extract `{ ts }` from draft keys, newest-first. Non-draft keys are skipped. */
export function parseDraftKeys(keys: string[]): DraftMeta[] {
  return keys
    .map((k) => {
      const m = k.match(/\/([^/]+)\.json$/);
      return m ? { ts: m[1] } : null;
    })
    .filter((d): d is DraftMeta => d !== null)
    .sort((a, b) => b.ts.localeCompare(a.ts));
}

/** Write a versioned draft; returns the ISO timestamp it was stored under. */
export async function putDraft(
  repoName: string,
  draft: { title?: string; articleMarkdown: string }
): Promise<string> {
  const ts = new Date().toISOString();
  const body: DraftBody = { savedAt: ts, title: draft.title, articleMarkdown: draft.articleMarkdown };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: draftKey(repoName, ts),
      Body: JSON.stringify(body),
      ContentType: "application/json",
    })
  );
  return ts;
}

/** List a repo's drafts newest-first, from key names only (no per-object read). */
export async function listDrafts(repoName: string): Promise<DraftMeta[]> {
  const res = await s3.send(
    new ListObjectsV2Command({ Bucket: bucketName(), Prefix: `drafts/${repoName}/` })
  );
  return parseDraftKeys((res.Contents ?? []).map((o) => o.Key ?? ""));
}

/** Fetch a specific draft's full body. Throws if missing. */
export async function getDraft(repoName: string, ts: string): Promise<DraftBody> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucketName(), Key: draftKey(repoName, ts) })
  );
  if (!res.Body) {
    throw new Error(`Draft not found: ${repoName} @ ${ts}`);
  }
  return JSON.parse(await res.Body.transformToString()) as DraftBody;
}
