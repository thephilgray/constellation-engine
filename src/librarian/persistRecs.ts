import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { ConstellationRecord } from "../lib/schemas";

const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.UnifiedLake.name;
const DASHBOARD_PK = "DASHBOARD#reading_list";
const DASHBOARD_SK = "STATE";

export const handler = async (event: { markdownContent: string }): Promise<{ success: boolean }> => {
  const { markdownContent } = event;
  if (!markdownContent || markdownContent.includes("No new book recommendations")) {
    console.log("No new content to persist. Skipping update.");
    return { success: true };
  }

  try {
    // Fetch existing record to preserve createdAt if possible
    let createdAt = new Date().toISOString();
    try {
        const getCmd = new GetCommand({
            TableName: TABLE_NAME,
            Key: { PK: DASHBOARD_PK, SK: DASHBOARD_SK }
        });
        const { Item } = await dynamoClient.send(getCmd);
        if (Item && Item.createdAt) {
            createdAt = Item.createdAt;
        }
    } catch (e) {
        console.warn("Could not fetch existing dashboard:", e);
    }

    const isoDate = new Date().toISOString();

    const record: ConstellationRecord = {
      PK: DASHBOARD_PK as any,
      SK: DASHBOARD_SK as any,
      id: "reading_list",
      type: "Dashboard",
      createdAt: createdAt,
      updatedAt: isoDate,
      content: markdownContent,
      isOriginal: false,
      mediaType: 'text',
      lastAccessed: isoDate,
    };

    await dynamoClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }));

    console.log(`Successfully persisted Reading List Dashboard to DynamoDB.`);
    return { success: true };

  } catch (error) {
    console.error(`Failed to persist recommendations:`, error);
    throw new Error("Failed to persist recommendations.");
  }
};