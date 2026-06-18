// src/diffpress/listHandoffs.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { listBoardItems } from "./lib/ledger";
import type { PublicationRecord } from "./types";

export interface DiscoveredItem {
  repoName: string;
  repoUrl?: string;
  description?: string;
  stars?: number;
  language?: string | null;
  pushedAt?: string;
  signalType?: "TRENDING" | "NEW" | "RELEASE";
  starsGained?: number;
  releaseTag?: string;
  coverageScore?: number;
}

export interface HandoffItem {
  repoName: string;
  repoUrl?: string;
  taskToken?: string;
  discoveredAt?: string;
  handoffPrompt?: string;
}

export interface DraftingItem {
  repoName: string;
  description?: string;
}

export interface ReviewItem {
  repoName: string;
  title?: string;
  publishedAt?: string;
}

export interface Board {
  discovered: DiscoveredItem[];
  readyForDev: HandoffItem[];
  drafting: DraftingItem[];
  inReview: ReviewItem[];
}

/** Pure: split ledger items into the four board columns the UI renders. */
export function bucketBoard(items: PublicationRecord[]): Board {
  const board: Board = { discovered: [], readyForDev: [], drafting: [], inReview: [] };
  for (const item of items) {
    switch (item.status) {
      case "DISCOVERED":
        board.discovered.push({
          repoName: item.repoName,
          repoUrl: item.repoUrl,
          description: item.description,
          stars: item.stars,
          language: item.language,
          pushedAt: item.pushedAt,
          signalType: item.signalType,
          starsGained: item.starsGained,
          releaseTag: item.releaseTag,
          coverageScore: item.coverageScore,
        });
        break;
      case "AWAITING_HANDOFF":
        board.readyForDev.push({
          repoName: item.repoName,
          repoUrl: item.repoUrl,
          taskToken: item.taskToken,
          discoveredAt: item.discoveredAt,
          handoffPrompt: item.handoffPrompt,
        });
        break;
      case "DRAFTING":
        board.drafting.push({
          repoName: item.repoName,
          description: item.description,
        });
        break;
      case "PUBLISHED":
        board.inReview.push({
          repoName: item.repoName,
          title: item.title,
          publishedAt: item.publishedAt,
        });
        break;
      // Unknown statuses are intentionally dropped (no default bucket).
    }
  }
  return board;
}

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const userId = (event.requestContext as any)?.authorizer?.jwt?.claims?.sub;
  if (!userId) {
    return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
  }
  try {
    const items = await listBoardItems();
    return { statusCode: 200, body: JSON.stringify(bucketBoard(items)) };
  } catch (error: any) {
    console.error("[listHandoffs] scan failed:", error);
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to load handoffs." }) };
  }
}
