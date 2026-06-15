// src/diffpress/publishHandoff.ts
import { SFNClient, SendTaskSuccessCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

const sfn = new SFNClient({});

export interface ParsedHandoff {
  taskToken: string;
  repoUrl: string;
  developerLog: string;
}

export type ParseResult =
  | { ok: true; value: ParsedHandoff }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + body. No AWS calls. */
export function parseHandoffEvent(event: APIGatewayProxyEventV2): ParseResult {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return { ok: false, statusCode: 401, message: "Unauthorized" };
  }
  if (!event.body) {
    return { ok: false, statusCode: 400, message: "Missing request body" };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(event.body);
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body" };
  }
  const { taskToken, repoUrl, developerLog } = parsed ?? {};
  if (
    typeof taskToken !== "string" ||
    typeof repoUrl !== "string" ||
    typeof developerLog !== "string"
  ) {
    return {
      ok: false,
      statusCode: 400,
      message: "taskToken, repoUrl and developerLog are required strings",
    };
  }
  return { ok: true, value: { taskToken, repoUrl, developerLog } };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseHandoffEvent(event);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: JSON.stringify({ message: parsed.message }) };
  }

  const { taskToken, repoUrl, developerLog } = parsed.value;
  try {
    await sfn.send(
      new SendTaskSuccessCommand({
        taskToken,
        output: JSON.stringify({ repoUrl, developerLog }),
      })
    );
    return { statusCode: 202, body: JSON.stringify({ message: "Workflow resumed." }) };
  } catch (error: any) {
    console.error("[publishHandoff] SendTaskSuccess failed:", error);
    // An invalid/expired token is a client problem; surface as 400.
    if (error?.name === "TaskDoesNotExist" || error?.name === "InvalidToken") {
      return { statusCode: 400, body: JSON.stringify({ message: "Invalid or expired task token." }) };
    }
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to resume workflow." }) };
  }
}
