import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Lazy read so tests can import without an SST binding; the type only exists
// after deploy (see signals.ts / ledger.ts for the same pattern).
function tableName(): string {
  return (Resource as unknown as { DiscoveryConfig: { name: string } })
    .DiscoveryConfig.name;
}

/** Master switch for the engine. `off` is a hard stop (discovery + ingest). */
export type EngineState = "active" | "paused" | "off";
/** Which Discovery lanes a run targets. */
export type DiscoveryMode = "frontier" | "balanced" | "ecosystem";

/** Runtime knobs driven by the Pipeline Command Center. */
export interface DiscoveryConfig {
  engineState: EngineState;
  discoveryMode: DiscoveryMode;
  velocity: number; // total candidate repos entering Discovery per week (1–20)
}

/** Defaults match the UI store's initial values. */
export const DEFAULT_CONFIG: DiscoveryConfig = {
  engineState: "active",
  discoveryMode: "frontier",
  velocity: 6,
};

/** Single-item config record key. */
const CONFIG_ID = "current";

/** Read the live config, falling back to defaults when nothing is stored yet. */
export async function getDiscoveryConfig(): Promise<DiscoveryConfig> {
  const { Item } = await docClient.send(
    new GetCommand({ TableName: tableName(), Key: { id: CONFIG_ID } })
  );
  if (!Item) return DEFAULT_CONFIG;
  return {
    engineState: (Item.engineState as EngineState) ?? DEFAULT_CONFIG.engineState,
    discoveryMode: (Item.discoveryMode as DiscoveryMode) ?? DEFAULT_CONFIG.discoveryMode,
    velocity: (Item.velocity as number) ?? DEFAULT_CONFIG.velocity,
  };
}

/** Persist the config (single fixed-key item). */
export async function putDiscoveryConfig(cfg: DiscoveryConfig): Promise<void> {
  await docClient.send(
    new PutCommand({ TableName: tableName(), Item: { id: CONFIG_ID, ...cfg } })
  );
}
