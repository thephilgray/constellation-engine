import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { ConstellationRecord } from "../lib/schemas";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.UnifiedLake.name;

async function getRecentEntries(): Promise<ConstellationRecord[]> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since = sevenDaysAgo.toISOString();

    console.log(`Fetching entries since: ${since}`);

    try {
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

        console.log(`Found ${entries.length} recent entries.`);
        return entries;

    } catch (error) {
        console.error("Error fetching recent entries from DynamoDB:", error);
        return [];
    }
}

async function getAllIngestedUrls(): Promise<string[]> {
    try {
        // Optimize: Only fetch the sourceURL attribute
        const command = new ScanCommand({
            TableName: TABLE_NAME,
            FilterExpression: "attribute_exists(sourceURL)",
            ProjectionExpression: "sourceURL",
        });

        const response = await dynamo.send(command);
        const items = response.Items || [];
        
        const urls = items
            .map((item: any) => item.sourceURL)
            .filter((url): url is string => !!url);

        return Array.from(new Set(urls));
    } catch (error) {
        console.error("Error fetching ingested URLs:", error);
        return [];
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

export const handler = async (): Promise<{ recentEntries: ConstellationRecord[]; pastRecsList: string[]; allIngestedUrls: string[] }> => {
    const [recentEntries, pastRecsList, allIngestedUrls] = await Promise.all([
        getRecentEntries(),
        getPastRecommendations(),
        getAllIngestedUrls()
    ]);

    if (recentEntries.length === 0) {
        console.log("No recent entries found in the last 7 days.");
    }

    return { recentEntries, pastRecsList, allIngestedUrls };
};