import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
  QueryCommand,
  BatchGetCommand,
  BatchWriteCommand,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { PublicationRecord } from "../types";
import type { PublishTargets } from "./publish";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Read the table name lazily so tests can import this module without an SST binding.
// Cast through unknown because SST only adds the resource type after `sst dev`/`sst deploy`.
function tableName(): string {
  return (Resource as unknown as { PublicationLifecycle: { name: string } })
    .PublicationLifecycle.name;
}

/** Pure: build a conditional UpdateCommand input that flips an item to PUBLISHED. */
export function buildMarkPublishedParams(
  table: string,
  repoName: string,
  meta: { title: string; publishedAt: string; articleMarkdown: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression:
      "SET #status = :published, title = :title, publishedAt = :publishedAt, articleMarkdown = :article",
    // Idempotent: do not re-publish an item already in PUBLISHED state.
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":published": "PUBLISHED",
      ":title": meta.title,
      ":publishedAt": meta.publishedAt,
      ":article": meta.articleMarkdown,
    },
  };
}

/** Pure: flip an item to DRAFTING (only if not already PUBLISHED). */
export function buildMarkDraftingParams(
  table: string,
  repoName: string
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression: "SET #status = :drafting",
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":drafting": "DRAFTING", ":published": "PUBLISHED" },
  };
}

/** Pure: flip a DISCOVERED item to AWAITING_HANDOFF, attaching resume metadata. */
export function buildMarkAwaitingParams(
  table: string,
  repoName: string,
  meta: { repoUrl: string; taskToken: string; payloadKey?: string; handoffPrompt?: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression:
      "SET #status = :awaiting, repoUrl = :repoUrl, taskToken = :taskToken, payloadKey = :payloadKey, handoffPrompt = :handoffPrompt, discoveredAt = if_not_exists(discoveredAt, :now)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":awaiting": "AWAITING_HANDOFF",
      ":repoUrl": meta.repoUrl,
      ":taskToken": meta.taskToken,
      ":payloadKey": meta.payloadKey ?? null,
      ":handoffPrompt": meta.handoffPrompt ?? null,
      ":now": new Date().toISOString(),
    },
  };
}

/** Pure: flip an item to DISMISSED (only if not already PUBLISHED). */
export function buildMarkDismissedParams(
  table: string,
  repoName: string
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression: "SET #status = :dismissed",
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: { ":dismissed": "DISMISSED", ":published": "PUBLISHED" },
  };
}

/** Pure: build an UpdateCommand input that flips an item to SCHEDULED. */
export function buildMarkScheduledParams(
  table: string,
  repoName: string,
  meta: { scheduleAt: string; targets: PublishTargets; seriesLink: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression:
      "SET #status = :scheduled, scheduleAt = :scheduleAt, targets = :targets, seriesLink = :seriesLink",
    ConditionExpression:
      "attribute_not_exists(#status) OR #status <> :published",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":scheduled": "SCHEDULED",
      ":published": "PUBLISHED",
      ":scheduleAt": meta.scheduleAt,
      ":targets": meta.targets,
      ":seriesLink": meta.seriesLink,
    },
  };
}

/** Pure: overwrite the handoff brief in place, only while still AWAITING_HANDOFF. */
export function buildSetHandoffPromptParams(
  table: string,
  repoName: string,
  meta: { handoffPrompt: string; mode?: "narrative" | "explainer" }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression: "SET handoffPrompt = :handoffPrompt, #mode = :mode",
    ConditionExpression: "#status = :awaiting",
    // `mode` and `status` are DynamoDB reserved words.
    ExpressionAttributeNames: { "#status": "status", "#mode": "mode" },
    ExpressionAttributeValues: {
      ":handoffPrompt": meta.handoffPrompt,
      ":mode": meta.mode ?? null,
      ":awaiting": "AWAITING_HANDOFF",
    },
  };
}

/** Pure: overwrite an existing article's markdown (and title) in place. */
export function buildSaveArticleParams(
  table: string,
  repoName: string,
  meta: { articleMarkdown: string; title?: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression: meta.title
      ? "SET articleMarkdown = :article, title = :title"
      : "SET articleMarkdown = :article",
    // Edit only an existing record; never conjure a new one from a stray repoName.
    ConditionExpression: "attribute_exists(repoName)",
    ExpressionAttributeValues: {
      ":article": meta.articleMarkdown,
      ...(meta.title ? { ":title": meta.title } : {}),
    },
  };
}

/** Pure: is this error a DynamoDB conditional-check failure (already published)? */
export function isAlreadyPublishedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

/** Fetch a single publication record by repoName, or null. */
export async function getByRepo(repoName: string): Promise<PublicationRecord | null> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: { repoName } })
  );
  return (Item as PublicationRecord) ?? null;
}

/** Flip the item to PUBLISHED. Swallows the conditional-check failure (idempotent). */
export async function markPublished(
  repoName: string,
  meta: { title: string; publishedAt: string; articleMarkdown: string }
): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand(buildMarkPublishedParams(tableName(), repoName, meta))
    );
  } catch (err) {
    if (isAlreadyPublishedError(err)) {
      console.log(`[ledger] ${repoName} already published; skipping.`);
      return;
    }
    throw err;
  }
}

export async function markScheduled(
  repoName: string,
  meta: { scheduleAt: string; targets: PublishTargets; seriesLink: string }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildMarkScheduledParams(tableName(), repoName, meta))
  );
}

/** Overwrite an existing article's markdown (and title) in place. */
export async function saveArticle(
  repoName: string,
  meta: { articleMarkdown: string; title?: string }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildSaveArticleParams(tableName(), repoName, meta))
  );
}

/**
 * Read the board via per-status Queries on the status GSI (no table scan).
 * Projects out `articleMarkdown` (fetched on demand) to keep the payload light.
 */
export async function listBoardItems(): Promise<PublicationRecord[]> {
  const statuses = ["DISCOVERED", "AWAITING_HANDOFF", "DRAFTING", "PUBLISHED"];
  const groups = await Promise.all(statuses.map((s) => queryByStatus(s)));
  return groups.flat();
}

/** Name of the status GSI declared in sst.config.ts. */
export const STATUS_INDEX = "status-index";

/**
 * Attributes projected by queryByStatus / listBoardItems.
 * Add fields here whenever board display or downstream logic needs them —
 * DynamoDB returns ONLY the listed attributes, so omissions are silent data loss.
 */
export const BOARD_PROJECTION =
  "repoName, #status, repoUrl, taskToken, discoveredAt, title, publishedAt, description, stars, #lang, pushedAt, signalType, starsGained, releaseTag, coverageScore, handoffPrompt, scheduleAt";

/** Flip an item to DRAFTING. Swallows the conditional-check failure (idempotent). */
export async function markDrafting(repoName: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand(buildMarkDraftingParams(tableName(), repoName))
    );
  } catch (err) {
    if (isAlreadyPublishedError(err)) {
      console.log(`[ledger] ${repoName} already published; skip DRAFTING.`);
      return;
    }
    throw err;
  }
}

/** Flip an item to DISMISSED. Swallows the conditional-check failure (idempotent). */
export async function markDismissed(repoName: string): Promise<void> {
  try {
    await docClient.send(
      new UpdateCommand(buildMarkDismissedParams(tableName(), repoName))
    );
  } catch (err) {
    if (isAlreadyPublishedError(err)) {
      console.log(`[ledger] ${repoName} already published; skip DISMISSED.`);
      return;
    }
    throw err;
  }
}

/** Overwrite the handoff brief for an AWAITING_HANDOFF item. */
export async function setHandoffPrompt(
  repoName: string,
  meta: { handoffPrompt: string; mode?: "narrative" | "explainer" }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildSetHandoffPromptParams(tableName(), repoName, meta))
  );
}

/** Flip a DISCOVERED item to AWAITING_HANDOFF with resume metadata. */
export async function markAwaitingHandoff(
  repoName: string,
  meta: { repoUrl: string; taskToken: string; payloadKey?: string; handoffPrompt?: string }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildMarkAwaitingParams(tableName(), repoName, meta))
  );
}

/** BatchGetItem the given repoNames; return the set that already exist. */
export async function batchGetExisting(repoNames: string[]): Promise<Set<string>> {
  if (repoNames.length === 0) return new Set();
  const found = new Set<string>();
  // BatchGetItem caps at 100 keys per request.
  for (let i = 0; i < repoNames.length; i += 100) {
    const chunk = repoNames.slice(i, i + 100);
    const { Responses } = await docClient.send(
      new BatchGetCommand({
        RequestItems: {
          [tableName()]: {
            Keys: chunk.map((repoName) => ({ repoName })),
            ProjectionExpression: "repoName",
          },
        },
      })
    );
    for (const item of Responses?.[tableName()] ?? []) {
      found.add((item as PublicationRecord).repoName);
    }
  }
  return found;
}

/** BatchWriteItem the given records (PutRequests). Chunks at 25 per request. */
export async function batchPutDiscovered(records: PublicationRecord[]): Promise<void> {
  for (let i = 0; i < records.length; i += 25) {
    const chunk = records.slice(i, i + 25);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName()]: chunk.map((Item) => ({ PutRequest: { Item } })),
        },
      })
    );
  }
}

/** Query the status GSI for every item with the given status. */
export async function queryByStatus(status: string): Promise<PublicationRecord[]> {
  const { Items } = await docClient.send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: STATUS_INDEX,
      KeyConditionExpression: "#status = :s",
      ExpressionAttributeNames: { "#status": "status", "#lang": "language" },
      ExpressionAttributeValues: { ":s": status },
      ProjectionExpression: BOARD_PROJECTION,
    })
  );
  return (Items ?? []) as PublicationRecord[];
}

/**
 * Return SCHEDULED items whose scheduleAt is at or before `nowIso`.
 * Queries the status GSI (no scan), then filters by time and re-reads each
 * full item (the GSI projects only board fields, not articleMarkdown).
 */
export async function queryScheduledDue(nowIso: string): Promise<PublicationRecord[]> {
  const scheduled = await queryByStatus("SCHEDULED");
  const due = scheduled.filter((r) => (r.scheduleAt ?? "") <= nowIso);
  const full = await Promise.all(due.map((r) => getByRepo(r.repoName)));
  return full.filter((r): r is PublicationRecord => r !== null);
}
