import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { ConstellationRecord } from "../lib/schemas";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.UnifiedLake.name;

async function getRecentWriting(): Promise<string> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since = sevenDaysAgo.toISOString();

    console.log(`Fetching writing since: ${since}`);

    try {
        // Scan the table for entries created in the last 7 days.
        // Note: For production with many users, a GSI on `type` and `createdAt` would be better.
        const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "#type = :type AND #createdAt >= :since",
            ExpressionAttributeNames: {
                "#type": "type",
                "#createdAt": "createdAt",
            },
            ExpressionAttributeValues: {
                ":type": "Entry",
                ":since": since,
            },
        });

        const response = await dynamo.send(command);
        const entries = (response.Items || []) as ConstellationRecord[];

        if (entries.length === 0) {
            return "";
        }

        console.log(`Found ${entries.length} recent entries.`);

        // Combine content
        return entries
            .map(entry => entry.content)
            .join("\n\n---\n\n");

    } catch (error) {
        console.error("Error fetching recent writing from DynamoDB:", error);
        return "";
    }
}


async function getPastRecommendations(): Promise<string[]> {
    try {
        // Query for recommendations stored under USER#SYSTEM
        const command = new QueryCommand({
            TableName: TABLE_NAME,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: {
                ":pk": "USER#SYSTEM"
            }
        });

        const response = await dynamo.send(command);
        const items = (response.Items || []) as ConstellationRecord[];

        if (items.length === 0) {
            console.log("No past recommendations found in DynamoDB.");
            return [];
        }

        // Extract titles from all recommendation entries
        const allTitles: string[] = [];
        for (const item of items) {
             // Simple regex to find markdown headings (e.g., "## Book Title")
             const titles = item.content.match(/^##\s*(.*)/gm);
             if (titles) {
                titles.forEach(t => allTitles.push(t.replace("## ", "").trim()));
             }
        }
        
        // Deduplicate
        return Array.from(new Set(allTitles));

    } catch (error: any) {
        console.error("Error fetching past recommendations from DynamoDB:", error);
        return [];
    }
}

export const handler = async (): Promise<{ recentWriting: string; pastRecsList: string[] }> => {
    const [recentWriting, pastRecsList] = await Promise.all([
        getRecentWriting(),
        getPastRecommendations(),
    ]);

    if (!recentWriting) {
        console.log("No recent writing found in the last 7 days.");
    }

    return { recentWriting, pastRecsList };
};