import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  type PutCommandInput,
  type UpdateCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { PublicationRecord } from "../types";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Read the table name lazily so tests can import this module without an SST binding.
// Cast through unknown because SST only adds the resource type after `sst dev`/`sst deploy`.
function tableName(): string {
  return (Resource as unknown as { PublicationLifecycle: { name: string } })
    .PublicationLifecycle.name;
}

/** Pure: build the PutCommand input for a pending (AWAITING_HANDOFF) item. */
export function buildPendingPutParams(
  table: string,
  record: PublicationRecord
): PutCommandInput {
  return {
    TableName: table,
    Item: { ...record },
  };
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

/** Write the AWAITING_HANDOFF item carrying the task token + payload location. */
export async function putPending(record: PublicationRecord): Promise<void> {
  await docClient.send(new PutCommand(buildPendingPutParams(tableName(), record)));
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

/**
 * Scan every ledger item for the board view. Projects out `articleMarkdown`
 * (fetched on demand via getByRepo) so the board payload stays light.
 */
export async function listBoardItems(): Promise<PublicationRecord[]> {
  const { Items } = await docClient.send(
    new ScanCommand({
      TableName: tableName(),
      ProjectionExpression:
        "repoName, #status, repoUrl, taskToken, payloadKey, discoveredAt, title, publishedAt",
      ExpressionAttributeNames: { "#status": "status" },
    })
  );
  return (Items ?? []) as PublicationRecord[];
}

/** Return the set of repoNames already in PUBLISHED status (for dedupe). */
export async function listPublishedNames(): Promise<string[]> {
  const { Items } = await docClient.send(
    new ScanCommand({
      TableName: tableName(),
      FilterExpression: "#status = :published",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":published": "PUBLISHED" },
      ProjectionExpression: "repoName",
    })
  );
  return (Items ?? []).map((i) => (i as PublicationRecord).repoName);
}
