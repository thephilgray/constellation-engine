import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  BatchWriteCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Read the table name lazily so tests can import this module without a binding.
// Cast through unknown because SST only adds the resource type after deploy.
function tableName(): string {
  return (Resource as unknown as { DiscoverySignals: { name: string } })
    .DiscoverySignals.name;
}

/**
 * One hourly signal bucket in the DiscoverySignals table.
 * PK `repoName`, SK `signalKey` (e.g. `STAR#2026-06-16-15`, `RELEASE#2026-06-16-15`).
 * Per-hour buckets make ingest idempotent (re-running an hour overwrites identically)
 * and let discovery sum a rolling window. TTL prunes buckets past the window.
 */
export interface SignalRow {
  repoName: string;
  signalKey: string;
  signalType: "STAR" | "RELEASE";
  bucketMs: number; // epoch ms of the event hour, for window filtering
  count?: number; // stars gained that hour (STAR rows)
  releaseTag?: string; // release tag (RELEASE rows)
  repoUrl?: string;
  ttl: number; // epoch seconds; DynamoDB TTL attribute
}

/** BatchWriteItem the given signal rows (PutRequests). Chunks at 25 per request. */
export async function batchPutSignals(rows: SignalRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 25) {
    const chunk = rows.slice(i, i + 25);
    await docClient.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName()]: chunk.map((Item) => ({ PutRequest: { Item } })),
        },
      })
    );
  }
}

/**
 * Scan the whole signals table. TTL keeps it to ~the rolling window, so the scan
 * stays small; callers filter by `bucketMs` for the exact window.
 */
export async function scanSignals(): Promise<SignalRow[]> {
  const rows: SignalRow[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const { Items, LastEvaluatedKey } = await docClient.send(
      new ScanCommand({ TableName: tableName(), ExclusiveStartKey })
    );
    for (const item of Items ?? []) rows.push(item as SignalRow);
    ExclusiveStartKey = LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
}
