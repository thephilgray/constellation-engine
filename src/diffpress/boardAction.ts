// src/diffpress/boardAction.ts
import { SFNClient, SendTaskFailureCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getByRepo, markDismissed, setHandoffPrompt } from "./lib/ledger";
import { getPayload } from "./lib/payloadStore";
import { buildMetaPrompt, generateBrief, resolveHandoff } from "./generateHandoff";
import type { PublicationRecord, RepoCandidate } from "./types";

const sfn = new SFNClient({});

export type BoardAction = "dismiss" | "regenerate-handoff";

export interface ParsedBoardAction {
  repoName: string;
  action: BoardAction;
}

export type ParseResult =
  | { ok: true; value: ParsedBoardAction }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + body. No AWS calls. */
export function parseBoardActionEvent(event: APIGatewayProxyEventV2): ParseResult {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) return { ok: false, statusCode: 401, message: "Unauthorized" };
  if (!event.body) return { ok: false, statusCode: 400, message: "Missing request body" };
  let parsed: any;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body" };
  }
  const { repoName, action } = parsed ?? {};
  if (typeof repoName !== "string" || !repoName) {
    return { ok: false, statusCode: 400, message: "repoName is required" };
  }
  if (action !== "dismiss" && action !== "regenerate-handoff") {
    return { ok: false, statusCode: 400, message: "action must be 'dismiss' or 'regenerate-handoff'" };
  }
  return { ok: true, value: { repoName, action } };
}

/** Pure: rebuild a RepoCandidate from a ledger row for handoff regeneration. */
export function reconstructCandidate(record: PublicationRecord): RepoCandidate {
  return {
    repoName: record.repoName,
    repoUrl: record.repoUrl ?? "",
    description: record.description ?? "",
    stars: record.stars ?? 0,
    language: record.language ?? null,
    pushedAt: record.pushedAt ?? "",
    signalType: record.signalType,
    starsGained: record.starsGained,
    releaseTag: record.releaseTag,
    coverageScore: record.coverageScore,
    coverageSources: record.coverageSources,
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return { statusCode, body: JSON.stringify(body) };
}

async function doDismiss(record: PublicationRecord): Promise<APIGatewayProxyResultV2> {
  if (record.status !== "DISCOVERED" && record.status !== "AWAITING_HANDOFF") {
    return json(400, { message: `Cannot dismiss a ${record.status} card.` });
  }
  // Ready-for-Dev: release the paused execution before flipping the row,
  // otherwise the Step Functions execution hangs until task-token timeout.
  if (record.status === "AWAITING_HANDOFF" && record.taskToken) {
    try {
      await sfn.send(
        new SendTaskFailureCommand({
          taskToken: record.taskToken,
          error: "DismissedByUser",
          cause: "Card dismissed from the DiffPress board.",
        })
      );
    } catch (err: any) {
      // Token already gone (resumed/expired) is fine — proceed to dismiss the row.
      if (err?.name !== "TaskDoesNotExist" && err?.name !== "InvalidToken") throw err;
    }
  }
  await markDismissed(record.repoName);
  return json(200, { message: "Card dismissed.", repoName: record.repoName });
}

async function doRegenerate(record: PublicationRecord): Promise<APIGatewayProxyResultV2> {
  if (record.status !== "AWAITING_HANDOFF") {
    return json(400, { message: "Only Ready-for-Dev cards can regenerate a handoff." });
  }
  if (!record.payloadKey) {
    return json(409, { message: "No enrichment payload on record; cannot regenerate." });
  }
  // Seed ideas are not persisted; regeneration omits them (brief falls back to
  // "invent an original idea"). Acceptable degradation. ponytail: re-thread seeds
  // through the ledger if briefs noticeably suffer.
  const payload = await getPayload(record.payloadKey);
  const prompt = buildMetaPrompt({
    repo: reconstructCandidate(record),
    documentation: payload.documentation,
    seedIdeas: [],
  });
  const raw = await generateBrief(prompt);
  const { mode, handoffPrompt } = resolveHandoff(raw, record.repoName);
  await setHandoffPrompt(record.repoName, { handoffPrompt, mode });
  return json(200, { message: "Handoff regenerated.", handoffPrompt });
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseBoardActionEvent(event);
  if (!parsed.ok) return json(parsed.statusCode, { message: parsed.message });

  const { repoName, action } = parsed.value;
  try {
    const record = await getByRepo(repoName);
    if (!record) return json(404, { message: `No card for ${repoName}.` });
    return action === "dismiss" ? doDismiss(record) : doRegenerate(record);
  } catch (error) {
    console.error(`[boardAction] ${action} failed for ${repoName}:`, error);
    return json(500, { message: "Board action failed." });
  }
}
