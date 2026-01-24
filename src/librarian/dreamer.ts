import { GoogleGenerativeAI } from "@google/generative-ai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import KSUID from "ksuid";
import { getEmbedding, queryPinecone, upsertToPinecone } from "../utils";
import type { ConstellationRecord, PineconeMetadata } from "../lib/schemas";

const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.UnifiedLake.name;
const PINECONE_INDEX_NAME = "brain-dump";

async function getRecord(userId: string, entryId: string): Promise<ConstellationRecord | null> {
    try {
        const response = await dynamoClient.send(new GetCommand({
            TableName: TABLE_NAME,
            Key: {
                PK: `USER#${userId}`,
                SK: `ENTRY#${entryId}`
            }
        }));
        return (response.Item as ConstellationRecord) || null;
    } catch (error) {
        console.error(`Error fetching record ${entryId}:`, error);
        return null;
    }
}

export const handler = async () => {
    console.log("Dreamer (Serendipity Engine) started...");

    try {
        // 1. Pick a Random Seed Entry
        // Generate a random vector to probe the latent space
        const randomVector = Array.from({ length: 768 }, () => Math.random() * 2 - 1);
        
        // Find the closest existing entry to this random point
        const seedResults = await queryPinecone(PINECONE_INDEX_NAME, randomVector, 1);

        if (!seedResults.matches || seedResults.matches.length === 0) {
            console.log("No entries found in Pinecone. Aborting.");
            return;
        }

        const seedMatch = seedResults.matches[0];
        const seedId = seedMatch.id;
        // Assume metadata contains userId, otherwise default to a known user or system
        const seedUserId = (seedMatch.metadata?.userId as string); // || "SYSTEM"? 

        if (!seedUserId) {
            console.log("Seed entry has no userId in metadata. Aborting.");
            return;
        }

        console.log(`Selected Seed Entry: ${seedId} (User: ${seedUserId})`);
        const seedRecord = await getRecord(seedUserId, seedId);

        if (!seedRecord) {
            console.log("Could not fetch seed record from DynamoDB.");
            return;
        }

        // 2. Find Distantly Related Item
        // Re-embed the seed content to get its exact vector (Pinecone query didn't return values)
        const seedVector = await getEmbedding(seedRecord.content);

        // Query for top 50 matches within the same user's data
        const relations = await queryPinecone(
            PINECONE_INDEX_NAME, 
            seedVector, 
            50, 
            undefined, 
            { userId: seedUserId }
        );

        const candidates = relations.matches?.filter(m => m.id !== seedId) || [];
        
        if (candidates.length < 5) {
            console.log("Not enough related items found for serendipity.");
            return;
        }

        // Pick a "distant" relative from the tail of the results (e.g., lower relevance)
        // We want something connected but not obvious.
        // Let's pick from the bottom half of the results.
        const minIndex = Math.floor(candidates.length / 2);
        const maxIndex = candidates.length - 1;
        const distantIndex = Math.floor(Math.random() * (maxIndex - minIndex + 1)) + minIndex;
        
        const distantMatch = candidates[distantIndex];
        console.log(`Selected Distant Entry: ${distantMatch.id} (Score: ${distantMatch.score})`);

        const distantRecord = await getRecord(seedUserId, distantMatch.id);

        if (!distantRecord) {
            console.log("Could not fetch distant record from DynamoDB.");
            return;
        }

        // 3. Synthesize Connection (The Spark)
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `
        You are a serendipity engine. I will present two seemingly disparate entries from the user's second brain.
        Your task is to find a creative, insightful, or surprising connection between them.
        
        **Entry A (The Anchor):**
        ${seedRecord.content}

        **Entry B (The Satellite):**
        ${distantRecord.content}

        **Instructions:**
        1. Identify the core concept of each.
        2. Find a "bridge" concept that links them. This could be metaphorical, structural, or thematic.
        3. Write a short "Spark" entry (1-2 paragraphs) synthesizing this new insight.
        4. Give it a title starting with "Spark: ".
        `;

        const result = await model.generateContent(prompt);
        const sparkContent = result.response.text();

        console.log("Generated Spark:", sparkContent);

        // 4. Save the Spark
        const id = (await KSUID.random()).string;
        const now = new Date().toISOString();

        const sparkRecord: ConstellationRecord = {
            PK: `USER#${seedUserId}`,
            SK: `ENTRY#${id}`,
            id,
            type: 'Entry',
            createdAt: now,
            updatedAt: now,
            content: sparkContent,
            isOriginal: true,
            sourceTitle: "The Dreamer (Serendipity Engine)",
            tags: ["spark", "serendipity", "dreamer"],
            mediaType: "text",
            lastAccessed: now
        };

        await dynamoClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: sparkRecord
        }));

        // Upsert to Pinecone
        const sparkVector = await getEmbedding(sparkContent);
        const pineconeMetadata: PineconeMetadata = {
            id,
            userId: seedUserId,
            isOriginal: true,
            mediaType: "text",
            createdAt: now,
            tags: ["spark", "serendipity", "dreamer"]
        };

        await upsertToPinecone(
            PINECONE_INDEX_NAME,
            id,
            sparkVector,
            pineconeMetadata as unknown as Record<string, any>
        );

        console.log(`Spark saved successfully: ${id}`);

    } catch (error) {
        console.error("Error in Dreamer execution:", error);
    }
};
