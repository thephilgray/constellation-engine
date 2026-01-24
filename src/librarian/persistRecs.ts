import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import KSUID from "ksuid";
import type { ConstellationRecord } from "../lib/schemas";
import { createOrUpdateFile } from "../utils";

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.UnifiedLake.name;
const RECOMMENDATIONS_PATH = "00_Book_Recommendations.md";

export const handler = async (event: { markdownContent: string }): Promise<{ success: boolean }> => {
  const { markdownContent } = event;
  if (!markdownContent || markdownContent.includes("No new book recommendations")) {
    console.log("No new content to persist. Skipping update.");
    return { success: true };
  }

  try {
    // 1. Update GitHub Dashboard
    await createOrUpdateFile(RECOMMENDATIONS_PATH, markdownContent, "chore: Update reading recommendations");
    
    // 2. Persist to DynamoDB
    const id = (await KSUID.random()).string;
    const now = new Date().toISOString();
    const userId = "SYSTEM"; 

    const record: ConstellationRecord = {
      PK: `USER#${userId}`,
      SK: `ENTRY#${id}`,
      id,
      type: "Recommendation",
      createdAt: now,
      updatedAt: now,
      content: markdownContent,
      isOriginal: true, 
      mediaType: 'text',
      tags: ['recommendations', 'librarian'],
      lastAccessed: now,
    };

    await dynamoClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }));

    console.log(`Successfully persisted recommendations to DynamoDB (ID: ${id}) and GitHub.`);
    return { success: true };

  } catch (error) {
    console.error(`Failed to persist recommendations:`, error);
    throw new Error("Failed to persist recommendations.");
  }
};