// src/diffpress/listHandoffs.ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { listBoardItems } from "./lib/ledger";
import type { PublicationRecord } from "./types";

export interface HandoffItem {
  repoName: string;
  repoUrl?: string;
  taskToken?: string;
  discoveredAt?: string;
}

export interface ReviewItem {
  repoName: string;
  title?: string;
  publishedAt?: string;
}

export interface Board {
  readyForDev: HandoffItem[];
  inReview: ReviewItem[];
}

/** Pure: split ledger items into the two board columns the UI renders. */
export function bucketBoard(items: PublicationRecord[]): Board {
  const readyForDev: HandoffItem[] = [];
  const inReview: ReviewItem[] = [];
  for (const item of items) {
    if (item.status === "AWAITING_HANDOFF") {
      readyForDev.push({
        repoName: item.repoName,
        repoUrl: item.repoUrl,
        taskToken: item.taskToken,
        discoveredAt: item.discoveredAt,
      });
    } else if (item.status === "PUBLISHED") {
      inReview.push({
        repoName: item.repoName,
        title: item.title,
        publishedAt: item.publishedAt,
      });
    }
  }
  return { readyForDev, inReview };
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
