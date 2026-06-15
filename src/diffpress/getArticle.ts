// src/diffpress/getArticle.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getByRepo } from "./lib/ledger";

export type RepoQueryResult =
  | { ok: true; repo: string }
  | { ok: false; statusCode: number; message: string };

/** Pure: validate auth + the `repo` query param. No AWS calls. */
export function parseRepoQuery(event: APIGatewayProxyEventV2): RepoQueryResult {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return { ok: false, statusCode: 401, message: "Unauthorized" };
  }
  const repo = event.queryStringParameters?.repo;
  if (typeof repo !== "string" || repo.trim() === "") {
    return { ok: false, statusCode: 400, message: "Missing required `repo` query parameter." };
  }
  return { ok: true, repo };
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const parsed = parseRepoQuery(event);
  if (!parsed.ok) {
    return { statusCode: parsed.statusCode, body: JSON.stringify({ message: parsed.message }) };
  }
  try {
    const record = await getByRepo(parsed.repo);
    if (!record || !record.articleMarkdown) {
      return { statusCode: 404, body: JSON.stringify({ message: "Article not found." }) };
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        repoName: record.repoName,
        title: record.title,
        articleMarkdown: record.articleMarkdown,
        publishedAt: record.publishedAt,
        status: record.status,
      }),
    };
  } catch (error: any) {
    console.error("[getArticle] read failed:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to load article." }) };
  }
}
