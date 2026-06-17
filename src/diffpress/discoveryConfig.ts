// src/diffpress/discoveryConfig.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import {
  getDiscoveryConfig,
  putDiscoveryConfig,
  DEFAULT_CONFIG,
  type DiscoveryConfig,
  type EngineState,
  type DiscoveryMode,
} from "./lib/config";

const ENGINE_STATES: EngineState[] = ["active", "paused", "off"];
const DISCOVERY_MODES: DiscoveryMode[] = ["frontier", "balanced", "ecosystem"];

/**
 * Pure: validate a POST body into a config. Rejects (null) on bad enums; clamps
 * velocity to 1–20; missing fields fall back to defaults.
 */
export function validateConfigInput(raw: unknown): DiscoveryConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const body = raw as Record<string, unknown>;

  const engineState = body.engineState ?? DEFAULT_CONFIG.engineState;
  const discoveryMode = body.discoveryMode ?? DEFAULT_CONFIG.discoveryMode;
  if (!ENGINE_STATES.includes(engineState as EngineState)) return null;
  if (!DISCOVERY_MODES.includes(discoveryMode as DiscoveryMode)) return null;

  const rawVelocity = Number(body.velocity ?? DEFAULT_CONFIG.velocity);
  const velocity = Number.isFinite(rawVelocity)
    ? Math.min(20, Math.max(1, Math.round(rawVelocity)))
    : DEFAULT_CONFIG.velocity;

  return {
    engineState: engineState as EngineState,
    discoveryMode: discoveryMode as DiscoveryMode,
    velocity,
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
  }

  const method = event.requestContext.http.method;
  try {
    if (method === "GET") {
      return { statusCode: 200, body: JSON.stringify(await getDiscoveryConfig()) };
    }
    if (method === "POST") {
      const parsed = event.body ? JSON.parse(event.body) : null;
      const cfg = validateConfigInput(parsed);
      if (!cfg) {
        return { statusCode: 400, body: JSON.stringify({ message: "Invalid config" }) };
      }
      await putDiscoveryConfig(cfg);
      return { statusCode: 200, body: JSON.stringify(cfg) };
    }
    return { statusCode: 405, body: JSON.stringify({ message: "Method not allowed" }) };
  } catch (error) {
    console.error("[discoveryConfig] failed:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Config request failed." }) };
  }
}
