import { GoogleGenAI } from "@google/genai";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, queryPinecone, sanitizeMarkdown } from "./utils";
import { saveRecord, getRecord } from "./lib/dynamo";
import type { ConstellationRecord } from "./lib/schemas";
import KSUID from "ksuid";

// Initialize Gemini client
const genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value });

const PINECONE_INDEX_NAME = "brain-dump";
const LYRICS_NAMESPACE = "lyrics";
const DASHBOARD_PK = "DASHBOARD#song_seeds";
const DASHBOARD_SK = "STATE";

const INITIAL_SONG_SEEDS_CONTENT = `# 🎵 Song Seeds
*Waiting for inspiration...*

## 🎸 Emerging Songs
(Clusters of lines that form a structure)

## 📦 Thematic Bins
(Lines grouped by vibe)

## 📥 Inbox
(Orphans)

## 🪦 Used / Archived
(Finished songs)
`;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    // Authentication: Support both API Key (legacy/server) and Cognito JWT (client)
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    const expectedApiKey = `Bearer ${Resource.INGEST_API_KEY.value}`;
    const isApiKeyValid = authHeader === expectedApiKey;
    const isCognitoValid = !!(event.requestContext as any).authorizer?.jwt;

    if (!isApiKeyValid && !isCognitoValid) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    // Extract User ID
    const userId = (event.requestContext as any).authorizer?.jwt?.claims?.sub as string || "default-user";

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: "Request body is empty." }) };
    }

    // 1. Ingest
    const { content: newLyric }: { content: string } = JSON.parse(event.body);

    // 2. Embed & Save
    const vector = await getEmbedding(newLyric);

    const timestamp = Date.now();
    const date = new Date(timestamp);
    const isoDate = date.toISOString();
    const entryId = (await KSUID.random()).string;

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      entryId,
      vector,
      { text: newLyric, timestamp, userId },
      LYRICS_NAMESPACE
    );

    // Save Entry to DynamoDB
    const entryRecord: ConstellationRecord = {
        PK: `USER#${userId}`,
        SK: `ENTRY#${entryId}`,
        id: entryId,
        type: "Entry",
        createdAt: isoDate,
        updatedAt: isoDate,
        content: newLyric,
        isOriginal: true,
        mediaType: "text",
        tags: ["lyrics"],
        lastAccessed: isoDate,
    };
    await saveRecord(entryRecord);

    // 3. Recall (Context)
    const similarLyrics = await queryPinecone(PINECONE_INDEX_NAME, vector, 15, LYRICS_NAMESPACE);
    const contextLyrics = similarLyrics.matches
      .map(m => `- "${m.metadata?.text}" `)
      .join("\n");

    // 4. Synthesize (The Songwriter Persona)
    let currentSongSeeds = INITIAL_SONG_SEEDS_CONTENT;
    const existingDashboard = await getRecord(DASHBOARD_PK, DASHBOARD_SK);
    if (existingDashboard && existingDashboard.content) {
        currentSongSeeds = existingDashboard.content;
    }

    const systemPrompt = `You are an expert Songwriting Assistant.

NEW LINE: ${newLyric}

RELEVANT FRAGMENTS (From Database):
${contextLyrics}

CURRENT DASHBOARD:
${currentSongSeeds}

INSTRUCTIONS:
1. Analyze the NEW LINE for **Meter**, **Rhyme Scheme**, and **Imagery**.
2. Look at the RELEVANT FRAGMENTS. Do any of them combine with the NEW LINE to form a Couplet, Verse, or Chorus?
3. Update the Dashboard:
   - **Section 1: Emerging Songs:** Create or update clusters of lines that belong together. Give them working titles (e.g., 'The Coffee Ballad').
   - **Section 2: Thematic Bins:** Group remaining lines by strong imagery (e.g., 'Nature', 'Tech', 'Heartbreak').
   - **Section 3: The Inbox:** Place the new line here if it fits nowhere else.

CONSTRAINT: Do not alter the raw text of the lyrics. Only group and arrange them.
IMPORTANT: Output RAW markdown only. Do not wrap the output in markdown code blocks. Do not include any conversational text.`;

    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ text: systemPrompt }]
    });
    let newSongSeeds = result.text || '';

    // 🧹 SANITIZE: Remove the wrapping ```markdown blocks
    newSongSeeds = sanitizeMarkdown(newSongSeeds);

    // 5. Update Dashboard in DynamoDB
    const dashboardRecord: ConstellationRecord = {
        PK: DASHBOARD_PK as any,
        SK: DASHBOARD_SK as any,
        id: "song_seeds",
        type: "Dashboard",
        createdAt: existingDashboard?.createdAt || isoDate,
        updatedAt: isoDate,
        content: newSongSeeds,
        isOriginal: false,
        mediaType: "text",
        lastAccessed: isoDate,
    };
    await saveRecord(dashboardRecord);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: "Lyric logged and song seeds updated successfully.",
        songSeeds: newSongSeeds
      }),
    };
  } catch (error: any) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
