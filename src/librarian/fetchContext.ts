import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { ConstellationRecord } from "../lib/schemas";

const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
const owner = Resource.GITHUB_OWNER.value;
const repo = Resource.GITHUB_REPO.value;
const recommendationsFile = "BookRecommendations.md";

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
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: recommendationsFile,
        });

        if (!('content' in data)) {
            return [];
        }

        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        // Simple regex to find markdown headings (e.g., "## Book Title")
        const titles = content.match(/^##\s*(.*)/gm);
        return titles ? titles.map(title => title.replace("## ", "").trim()) : [];

    } catch (error: any) {
        if (error.status === 404) {
            console.log(`${recommendationsFile} not found. Assuming no past recommendations.`);
            return [];
        }
        console.error("Error fetching past recommendations:", error);
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
