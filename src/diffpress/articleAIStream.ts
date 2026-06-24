// src/diffpress/articleAIStream.ts
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { Type } from "@google/genai";
import { sanitizeMarkdown } from "../utils";
import {
  getGenAI,
  MODEL,
  parseAIRequest,
  buildReviewPrompt,
  parseReviewResponse,
  buildRevisePrompt,
} from "./articleAI";
import { parseDraftResponse } from "./draftArticle";
import { verifyJwt } from "./jwtAuth";

// `awslambda` is the global injected into the Lambda Node runtime for streaming.
// Read it off globalThis so importing this module in unit tests (where the
// global is absent) doesn't throw at load time.
type AwsLambda = {
  streamifyResponse: (
    fn: (event: APIGatewayProxyEventV2, responseStream: NodeJS.WritableStream) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (
      stream: NodeJS.WritableStream,
      metadata: { statusCode: number; headers: Record<string, string> },
    ) => NodeJS.WritableStream;
  };
};
const awslambda = (globalThis as any).awslambda as AwsLambda | undefined;

export function formatSSE(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const NOTE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    notes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          anchorText: { type: Type.STRING },
          note: { type: Type.STRING },
          replacement: { type: Type.STRING },
        },
        required: ["anchorText", "note", "replacement"],
      },
    },
  },
  required: ["notes"],
};

const REVISE_SCHEMA = {
  type: Type.OBJECT,
  properties: { title: { type: Type.STRING }, articleMarkdown: { type: Type.STRING } },
  required: ["title", "articleMarkdown"],
};

async function streamHandler(
  event: APIGatewayProxyEventV2,
  responseStream: NodeJS.WritableStream,
): Promise<void> {
  const stream = awslambda!.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });

  const write = (obj: unknown) => stream.write(formatSSE(obj));

  try {
    await verifyJwt(event);
  } catch {
    write({ error: "Unauthorized" });
    stream.end();
    return;
  }

  // parseAIRequest expects an authorizer claim; for the Function URL we've
  // already verified the JWT, so synthesize the shape it validates against.
  const req = parseAIRequest({
    ...event,
    requestContext: { authorizer: { jwt: { claims: { sub: "verified" } } } } as any,
  });
  if (!req.ok) {
    write({ error: req.message });
    stream.end();
    return;
  }

  try {
    if (req.action === "review") {
      // Stream the model output, accumulate, then parse + emit notes. Gemini
      // structured output finalizes the JSON at the end; this still fixes the
      // 30s cap (no API Gateway in the path) and reveals notes as they parse.
      // ponytail: accumulate-then-emit; switch to JSONL parse-per-line if reveal must be incremental
      let buf = "";
      const result = await getGenAI().models.generateContentStream({
        model: MODEL,
        contents: [{ text: buildReviewPrompt(req.articleMarkdown) }],
        config: { responseMimeType: "application/json", responseSchema: NOTE_SCHEMA },
      });
      for await (const chunk of result) buf += chunk.text ?? "";
      for (const note of parseReviewResponse(buf)) write({ note });
      write({ done: true });
    } else if (req.action === "revise") {
      // Revise uses the same JSON contract as the buffered handler
      // ({title, articleMarkdown}); stream it only to dodge the 30s cap, then
      // parse once and emit the body as a single chunk. The frontend
      // re-seeds from the accumulated chunk(s), so one chunk is sufficient.
      // ponytail: stream JSON to beat the timeout, parse once; per-token reveal is YAGNI
      let buf = "";
      const result = await getGenAI().models.generateContentStream({
        model: MODEL,
        contents: [{ text: buildRevisePrompt(req) }],
        config: { responseMimeType: "application/json", responseSchema: REVISE_SCHEMA },
      });
      for await (const chunk of result) buf += chunk.text ?? "";
      const { title, articleMarkdown } = parseDraftResponse(buf);
      write({ chunk: sanitizeMarkdown(articleMarkdown) });
      write({ title, done: true });
    } else {
      write({ error: "reply is not streamed; use POST /api/articles/ai" });
    }
  } catch (err: any) {
    console.error(`[articleAIStream:${req.action}] failed:`, err);
    write({ error: "AI request failed." });
  }
  stream.end();
}

export const handler =
  typeof awslambda?.streamifyResponse === "function"
    ? awslambda.streamifyResponse(streamHandler)
    : undefined;
