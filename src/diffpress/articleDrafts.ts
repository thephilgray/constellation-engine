// src/diffpress/articleDrafts.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { listDrafts, getDraft } from "./lib/draftStore";

export type DraftsQueryResult =
  | { ok: true; repo: string; ts: string | undefined }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + the `repo` (and optional `ts`) query params. No AWS calls. */
export function parseDraftsQuery(event: APIGatewayProxyEventV2): DraftsQueryResult {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return { ok: false, statusCode: 401, message: "Unauthorized" };
  }
  const repo = event.queryStringParameters?.repo;
  if (typeof repo !== "string" || repo.trim() === "") {
    return { ok: false, statusCode: 400, message: "Missing required `repo` query parameter." };
  }
  const ts = event.queryStringParameters?.ts;
  return { ok: true, repo, ts: typeof ts === "string" && ts.trim() !== "" ? ts : undefined };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseDraftsQuery(event);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: JSON.stringify({ message: parsed.message }) };
  }
  try {
    if (parsed.ts) {
      const draft = await getDraft(parsed.repo, parsed.ts);
      return { statusCode: 200, body: JSON.stringify({ ts: parsed.ts, ...draft }) };
    }
    const drafts = await listDrafts(parsed.repo);
    return { statusCode: 200, body: JSON.stringify({ drafts }) };
  } catch (error: any) {
    console.error("[articleDrafts] read failed:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to load drafts." }) };
  }
}
