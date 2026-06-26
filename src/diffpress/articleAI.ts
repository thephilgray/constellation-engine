// src/diffpress/articleAI.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { GoogleGenAI, Type } from "@google/genai";
import { Resource } from "sst";
import { sanitizeMarkdown } from "../utils";
import { parseDraftResponse } from "./draftArticle";

export const MODEL = "gemini-2.5-pro";

// Lazy init so importing this module in unit tests needs no SST bindings.
let genAI: GoogleGenAI | undefined;
export function getGenAI(): GoogleGenAI {
  if (!genAI) genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value });
  return genAI;
}

export type ReviewNote = { id: string; anchorText: string; note: string; replacement: string };

export type AIRequest =
  | { ok: true; action: "review"; repo: string; articleMarkdown: string; focus?: string }
  | {
      ok: true;
      action: "reply";
      articleMarkdown: string;
      note: string;
      conversation: string[];
      message: string;
    }
  | { ok: true; action: "revise"; repo: string; articleMarkdown: string; instruction: string }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + the action discriminator + per-action body. No AWS calls. */
export function parseAIRequest(event: APIGatewayProxyEventV2): AIRequest {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) return { ok: false, statusCode: 401, message: "Unauthorized" };

  let body: any;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body." };
  }
  const str = (v: unknown): v is string => typeof v === "string";
  const bad = (message: string) => ({ ok: false as const, statusCode: 400, message });

  switch (body.action) {
    case "review":
      if (!str(body.repo) || !body.repo.trim()) return bad("Missing required `repo`.");
      if (!str(body.articleMarkdown)) return bad("Missing required `articleMarkdown`.");
      return {
        ok: true,
        action: "review",
        repo: body.repo,
        articleMarkdown: body.articleMarkdown,
        ...(str(body.focus) && body.focus.trim() ? { focus: body.focus.trim() } : {}),
      };
    case "reply":
      if (!str(body.articleMarkdown)) return bad("Missing required `articleMarkdown`.");
      if (!str(body.note)) return bad("Missing required `note`.");
      if (!str(body.message) || !body.message.trim()) return bad("Missing required `message`.");
      return {
        ok: true,
        action: "reply",
        articleMarkdown: body.articleMarkdown,
        note: body.note,
        conversation: Array.isArray(body.conversation) ? body.conversation.filter(str) : [],
        message: body.message,
      };
    case "revise":
      if (!str(body.repo) || !body.repo.trim()) return bad("Missing required `repo`.");
      if (!str(body.articleMarkdown)) return bad("Missing required `articleMarkdown`.");
      if (!str(body.instruction) || !body.instruction.trim()) return bad("Missing required `instruction`.");
      return {
        ok: true,
        action: "revise",
        repo: body.repo,
        articleMarkdown: body.articleMarkdown,
        instruction: body.instruction,
      };
    default:
      return bad("Unknown or missing `action`.");
  }
}

// ---- review ----

export function buildReviewPrompt(articleMarkdown: string, focus?: string): string {
  return [
    `You are the AI Tech Editor for DiffPress. Critique the Markdown article below and return concrete, actionable line edits.`,
    ...(focus?.trim()
      ? [``, `Focus especially on: ${focus.trim()}. Still flag any other serious issues you notice.`]
      : []),
    ``,
    `For each note, return:`,
    `- "anchorText": a VERBATIM substring copied exactly from the article that the note refers to (do NOT paraphrase or trim — it must appear character-for-character in the article so it can be located and replaced).`,
    `- "note": the critique (what's weak and why).`,
    `- "replacement": your proposed replacement for that exact span.`,
    ``,
    `Return only substantive edits — skip nitpicks. If the article is solid, return an empty notes array.`,
    ``,
    `## Article`,
    articleMarkdown,
  ].join("\n");
}

export function parseReviewResponse(rawText: string): ReviewNote[] {
  const text = (rawText ?? "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("articleAI.review: model output was not valid JSON.");
  }
  const notes = (parsed as { notes?: unknown }).notes;
  if (!Array.isArray(notes)) return [];
  return notes
    .filter(
      (n): n is { id?: string; anchorText: string; note: string; replacement: string } =>
        !!n &&
        typeof n.anchorText === "string" &&
        typeof n.note === "string" &&
        typeof n.replacement === "string",
    )
    .map((n, i) => ({
      id: typeof n.id === "string" && n.id ? n.id : `note-${i}-${Math.random().toString(36).slice(2, 8)}`,
      anchorText: n.anchorText,
      note: n.note,
      replacement: n.replacement,
    }));
}

// ---- reply ----

export function buildReplyPrompt(input: {
  articleMarkdown: string;
  note: string;
  conversation: string[];
  message: string;
}): string {
  return [
    `You are the AI Tech Editor for DiffPress, discussing one of your own review notes with the author.`,
    `Respond to their pushback. If they convince you, you MAY return a revised "replacement" for the span; otherwise omit it.`,
    ``,
    `## Your original note`,
    input.note,
    ``,
    `## Conversation so far`,
    input.conversation.length ? input.conversation.join("\n") : "(none)",
    ``,
    `## Author's message`,
    input.message,
    ``,
    `## Article (for context)`,
    input.articleMarkdown,
  ].join("\n");
}

export function parseReplyResponse(rawText: string): { reply: string; replacement?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse((rawText ?? "").trim());
  } catch {
    throw new Error("articleAI.reply: model output was not valid JSON.");
  }
  const obj = parsed as { reply?: unknown; replacement?: unknown };
  if (typeof obj.reply !== "string" || !obj.reply.trim()) {
    throw new Error("articleAI.reply: model output missing `reply`.");
  }
  return typeof obj.replacement === "string"
    ? { reply: obj.reply, replacement: obj.replacement }
    : { reply: obj.reply };
}

// ---- revise ----

export function buildRevisePrompt(input: { articleMarkdown: string; instruction: string }): string {
  return [
    `You are the staff writer for DiffPress. Revise the Markdown article below per the editor's instruction.`,
    `Return a JSON object with "title" and the full rewritten "articleMarkdown" (GitHub-flavored Markdown, beginning at a level-2 heading).`,
    ``,
    `## Instruction`,
    input.instruction,
    ``,
    `## Current article`,
    input.articleMarkdown,
  ].join("\n");
}

// ---- Gemini calls ----

async function generateJSON(prompt: string, schema: any): Promise<string> {
  const result = await getGenAI().models.generateContent({
    model: MODEL,
    contents: [{ text: prompt }],
    config: { responseMimeType: "application/json", responseSchema: schema },
  });
  return result.text ?? "";
}

const NOTE_PROPS = {
  id: { type: Type.STRING },
  anchorText: { type: Type.STRING },
  note: { type: Type.STRING },
  replacement: { type: Type.STRING },
};

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const req = parseAIRequest(event);
  if (!req.ok) {
    return { statusCode: req.statusCode, body: JSON.stringify({ message: req.message }) };
  }
  try {
    if (req.action === "review") {
      const raw = await generateJSON(buildReviewPrompt(req.articleMarkdown, req.focus), {
        type: Type.OBJECT,
        properties: {
          notes: {
            type: Type.ARRAY,
            items: { type: Type.OBJECT, properties: NOTE_PROPS, required: ["anchorText", "note", "replacement"] },
          },
        },
        required: ["notes"],
      });
      return { statusCode: 200, body: JSON.stringify({ notes: parseReviewResponse(raw) }) };
    }
    if (req.action === "reply") {
      const raw = await generateJSON(buildReplyPrompt(req), {
        type: Type.OBJECT,
        properties: { reply: { type: Type.STRING }, replacement: { type: Type.STRING } },
        required: ["reply"],
      });
      return { statusCode: 200, body: JSON.stringify(parseReplyResponse(raw)) };
    }
    // revise
    const raw = await generateJSON(buildRevisePrompt(req), {
      type: Type.OBJECT,
      properties: { title: { type: Type.STRING }, articleMarkdown: { type: Type.STRING } },
      required: ["title", "articleMarkdown"],
    });
    const { title, articleMarkdown } = parseDraftResponse(raw);
    return { statusCode: 200, body: JSON.stringify({ title, articleMarkdown: sanitizeMarkdown(articleMarkdown) }) };
  } catch (error: any) {
    console.error(`[articleAI:${req.action}] failed:`, error);
    return { statusCode: 500, body: JSON.stringify({ message: "AI request failed." }) };
  }
}
