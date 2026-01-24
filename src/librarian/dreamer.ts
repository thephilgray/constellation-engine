import { GoogleGenerativeAI } from "@google/generative-ai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import KSUID from "ksuid";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getEmbedding, queryPinecone, upsertToPinecone, appendToFile, createOrUpdateFile, getFile, sanitizeMarkdown } from "../utils";
import type { ConstellationRecord, PineconeMetadata } from "../lib/schemas";

const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.UnifiedLake.name;
const PINECONE_INDEX_NAME = "brain-dump";

// Constants for Dream Logging
const DREAMS_NAMESPACE = "dreams";
const DREAM_JOURNAL_ANALYSIS_PATH = "00_Dream_Journal_Analysis.md";
const DREAMS_FOLDER = "Dreams";

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

export const handler = async (event?: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2 | void> => {
    console.log("Dreamer started...");

    try {
        // Determine Context (API vs Cron)
        const userId = event?.requestContext?.authorizer?.jwt?.claims?.sub as string | undefined;
        const isApiRequest = !!userId;
        let contentToLog: string | undefined;

        if (event?.body) {
            try {
                const body = JSON.parse(event.body);
                contentToLog = body.content;
            } catch (e) {
                console.warn("Could not parse event body", e);
            }
        }

        // ==========================================
        // BRANCH A: DREAM LOGGING (Input Provided)
        // ==========================================
        if (contentToLog) {
            console.log("Mode: Dream Logging");
            const newDream = contentToLog;

            // 1. Embed & Save
            const vector = await getEmbedding(newDream);
            const timestamp = Date.now();
            const date = new Date(timestamp);
            const isoDate = date.toISOString().split('T')[0];

            await upsertToPinecone(
                PINECONE_INDEX_NAME,
                `dream-${timestamp}`,
                vector,
                { text: newDream, timestamp, date: isoDate, userId: userId || "system" },
                DREAMS_NAMESPACE
            );

            const dreamArchivePath = `${DREAMS_FOLDER}/${isoDate}.md`;
            await appendToFile(dreamArchivePath, newDream, `dream: ${isoDate}`);

            // 2. Recall (Context)
            // Filter by userId if available
            const filter = userId ? { userId } : undefined;
            const similarDreams = await queryPinecone(PINECONE_INDEX_NAME, vector, 5, DREAMS_NAMESPACE, filter);
            const contextDreams = similarDreams.matches
                .map(m => `- "${m.metadata?.text}" `)
                .join("\n");

            // 3. Synthesize (Gemini 2.5 Flash)
            let currentAnalysis = "";
            try {
                const file = await getFile(DREAM_JOURNAL_ANALYSIS_PATH);
                currentAnalysis = file.content;
            } catch (e) {
                console.log("No existing analysis found.");
            }

            const systemPrompt = `
              You are a Jungian Analyst. Your task is to interpret a new dream in the context of recent, similar dreams and update a running analysis document. Focus on identifying recurring symbols (e.g., water, falling, animals, specific people), emotional themes, and potential narrative threads.
        
              **Current Dream Journal Analysis:**
              ${currentAnalysis}
        
              **New Dream:**
              "${newDream}"
        
              **Context from similar dreams:**
              ${contextDreams}
        
              **Instructions:**
              - Integrate the new dream's themes and symbols into the existing analysis.
              - Update the "Recurring Symbols" and "Emotional Landscape" sections.
              - If a new major theme emerges, add a new section for it.
              - Keep the analysis concise and focused on symbolic meaning.
              - Maintain the markdown structure.
              - Output RAW markdown only. Do not wrap the output in markdown code blocks.
            `;

            const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Using 2.0 Flash for consistency
            const result = await generativeModel.generateContent(systemPrompt);
            let newAnalysis = result.response.text();

            // 🧹 SANITIZE
            newAnalysis = sanitizeMarkdown(newAnalysis);

            // 4. Update Analysis File
            await createOrUpdateFile(DREAM_JOURNAL_ANALYSIS_PATH, newAnalysis, "chore: Update dream journal analysis");

            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: "Dream logged and analyzed.",
                    dreamAnalysis: newAnalysis
                })
            };
        }

        // ==========================================
        // BRANCH B: SERENDIPITY ENGINE (No Input)
        // ==========================================
        console.log("Mode: Serendipity Engine");
        
        // 1. Pick a Random Seed Entry
        const randomVector = Array.from({ length: 768 }, () => Math.random() * 2 - 1);
        const filter = userId ? { userId } : undefined;

        // Find the closest existing entry to this random point
        const seedResults = await queryPinecone(PINECONE_INDEX_NAME, randomVector, 1, undefined, filter);

        if (!seedResults.matches || seedResults.matches.length === 0) {
            console.log("No entries found in Pinecone. Aborting.");
            if (isApiRequest) {
                 return { statusCode: 404, body: JSON.stringify({ message: "No entries found to dream about." }) };
            }
            return;
        }

        const seedMatch = seedResults.matches[0];
        const seedId = seedMatch.id;
        // Assume metadata contains userId, otherwise default to a known user or system
        const seedUserId = (seedMatch.metadata?.userId as string); 

        if (!seedUserId) {
            console.log("Seed entry has no userId in metadata. Aborting.");
             if (isApiRequest) {
                 return { statusCode: 500, body: JSON.stringify({ message: "Seed entry corrupted." }) };
            }
            return;
        }

        console.log(`Selected Seed Entry: ${seedId} (User: ${seedUserId})`);
        const seedRecord = await getRecord(seedUserId, seedId);

        if (!seedRecord) {
            console.log("Could not fetch seed record from DynamoDB.");
             if (isApiRequest) {
                 return { statusCode: 500, body: JSON.stringify({ message: "Could not fetch seed record." }) };
            }
            return;
        }

        // 2. Find Distantly Related Item
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
             if (isApiRequest) {
                 return { statusCode: 200, body: JSON.stringify({ message: "Not enough connections yet. Keep adding entries!" }) };
            }
            return;
        }

        const minIndex = Math.floor(candidates.length / 2);
        const maxIndex = candidates.length - 1;
        const distantIndex = Math.floor(Math.random() * (maxIndex - minIndex + 1)) + minIndex;
        
        const distantMatch = candidates[distantIndex];
        console.log(`Selected Distant Entry: ${distantMatch.id} (Score: ${distantMatch.score})`);

        const distantRecord = await getRecord(seedUserId, distantMatch.id);

        if (!distantRecord) {
            console.log("Could not fetch distant record from DynamoDB.");
             if (isApiRequest) {
                 return { statusCode: 500, body: JSON.stringify({ message: "Could not fetch distant record." }) };
            }
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

        if (isApiRequest) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    message: "Dream cycle complete.",
                    spark: sparkContent,
                    entries: {
                        anchor: seedRecord.content,
                        satellite: distantRecord.content
                    }
                })
            };
        }

    } catch (error: any) {
        console.error("Error in Dreamer execution:", error);
         if (event?.requestContext) { 
             return {
                statusCode: 500,
                body: JSON.stringify({ message: "Internal Error", error: error.message })
             }
         }
    }
};