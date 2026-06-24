// src/diffpress/saveArticle.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { saveArticle } from "./lib/ledger";

export type SaveArticleInput =
  | { ok: true; repo: string; articleMarkdown: string; title?: string }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + the JSON body. No AWS calls. */
export function parseSaveArticle(event: APIGatewayProxyEventV2): SaveArticleInput {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return { ok: false, statusCode: 401, message: "Unauthorized" };
  }
  let body: any;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return { ok: false, statusCode: 400, message: "Invalid JSON body." };
  }
  const repo = body.repo;
  if (typeof repo !== "string" || repo.trim() === "") {
    return { ok: false, statusCode: 400, message: "Missing required `repo`." };
  }
  if (typeof body.articleMarkdown !== "string") {
    return { ok: false, statusCode: 400, message: "Missing required `articleMarkdown`." };
  }
  return {
    ok: true,
    repo,
    articleMarkdown: body.articleMarkdown,
    title: typeof body.title === "string" ? body.title : undefined,
  };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseSaveArticle(event);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: JSON.stringify({ message: parsed.message }) };
  }
  try {
    await saveArticle(parsed.repo, {
      articleMarkdown: parsed.articleMarkdown,
      title: parsed.title,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  } catch (error: any) {
    if (error?.name === "ConditionalCheckFailedException") {
      return { statusCode: 404, body: JSON.stringify({ message: "Article not found." }) };
    }
    console.error("[saveArticle] write failed:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to save article." }) };
  }
}
