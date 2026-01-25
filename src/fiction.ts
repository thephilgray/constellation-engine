import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, queryPinecone, sanitizeMarkdown } from "./utils";
import { saveRecord, getRecord } from "./lib/dynamo";
import type { ConstellationRecord } from "./lib/schemas";
import KSUID from "ksuid";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const PINECONE_INDEX_NAME = "brain-dump";
const FICTION_NAMESPACE = "fiction";
const DASHBOARD_PK = "DASHBOARD#story_bible";
const DASHBOARD_SK = "STATE";

const STORY_BIBLE_TEMPLATE = `# 📖 Story Bible
*The current state of the universe.*

## 🦸 Characters
(Protagonists, Antagonists, Relationships)

## 🗺️ World & Locations
(Settings, Rules, History)

## 🧶 Active Plot Threads
(Open loops, Conflicts)

## 🎬 Recent Scenes
(Chronological log of drafted scenes)

## ⚠️ Conflicts / Questions
(Potential plot holes)

## 💡 Unsorted Ideas
(Fragments, Dialogue snippets)
`;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    // Authentication: Support both API Key (legacy/server) and Cognito JWT (client)
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    const expectedApiKey = `Bearer ${Resource.INGEST_API_KEY.value}`;
    const isApiKeyValid = authHeader === expectedApiKey;
    const isCognitoValid = !!event.requestContext.authorizer?.jwt;

    if (!isApiKeyValid && !isCognitoValid) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }
    
    // Extract User ID
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub as string || "default-user";

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: "Request body is empty." }) };
    }

    // 1. Ingest
    const { content, tag = "IDEA" }: { content: string, tag: "IDEA" | "SCENE" | "CHARACTER" } = JSON.parse(event.body);

    // 2. Embed & Save to Vector DB
    const vector = await getEmbedding(content);
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const isoDate = date.toISOString();
    const entryId = (await KSUID.random()).string;

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      entryId,
      vector,
      { text: content, tag, timestamp, date: isoDate, userId },
      FICTION_NAMESPACE
    );

    // 3. Save Entry to Unified Lake (DynamoDB)
    // This replaces the old file-based archiving.
    const entryRecord: ConstellationRecord = {
        PK: `USER#${userId}`,
        SK: `ENTRY#${entryId}`,
        id: entryId,
        type: "Entry",
        createdAt: isoDate,
        updatedAt: isoDate,
        content: content,
        isOriginal: true,
        mediaType: "text",
        tags: ["fiction", tag.toLowerCase()],
        lastAccessed: isoDate,
    };
    await saveRecord(entryRecord);

    // 4. "Lore Keeper" Logic
    // Step A: Recall
    const similarItems = await queryPinecone(PINECONE_INDEX_NAME, vector, 10, FICTION_NAMESPACE);
    const context = similarItems.matches
      .map(m => `- "${m.metadata?.text}" (Tag: ${m.metadata?.tag})`)
      .join("\n");

    // Fetch Story Bible from DynamoDB
    let storyBibleContent = STORY_BIBLE_TEMPLATE;
    const existingDashboard = await getRecord(DASHBOARD_PK, DASHBOARD_SK);
    if (existingDashboard && existingDashboard.content) {
        storyBibleContent = existingDashboard.content;
    }

    // Step B: System Prompt (Dynamic based on Tag)
    let systemPrompt: string;
    if (tag === 'SCENE') {
      systemPrompt = `
        You are the Continuity Editor analyzing a new draft scene.
        1. **DO NOT** summarize the scene text in the main Bible sections.
        2. Instead, **Extract Facts**: What new information does this scene establish? (e.g., 'Protagonist has a scar', 'The bomb is disarmed').
        3. Update the 'Characters' or 'World' sections with these *extracted facts*.
        4. Add a one-line entry to the '## 🎬 Recent Scenes' section: 
        5. **Conflict Check**: Does this scene violate any rules in the current Bible? If so, log it under '⚠️ Conflicts / Questions'.

        **Current Story Bible:**
        ---
        ${storyBibleContent}
        ---

        **New Scene Draft:**
        ---
        ${content}
        ---

        **Related ideas from the knowledge base:**
        ---
        ${context}
        ---

        Now, output the **complete, updated Story Bible** with the new information integrated.
        IMPORTANT: Output RAW markdown only. Do not wrap the output in markdown code blocks. Do not include any conversational text.
      `;
    } else { // IDEA or CHARACTER
      systemPrompt = `
        You are the Continuity Editor. Your task is to integrate new information into the Story Bible.
        1. Update the Story Bible based on this new information.
        2. If this new information contradicts established facts (e.g., existing text says 'Jack is dead' but new info says 'Jack is eating'), you MUST log the contradiction in the '⚠️ Conflicts / Questions' section.
        3. **Do not** delete established facts from the bible unless the new information explicitly says it is a retcon.

        **Current Story Bible:**
        ---
        ${storyBibleContent}
        ---

        **New Information (Tag: ${tag}):**
        ---
        ${content}
        ---

        **Related ideas from the knowledge base:**
        ---
        ${context}
        ---

        Now, output the **complete, updated Story Bible** with the new information integrated.
        IMPORTANT: Output RAW markdown only. Do not wrap the output in markdown code blocks. Do not include any conversational text.
      `;
    }

    const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await generativeModel.generateContent(systemPrompt);
    let newBibleContent = result.response.text();

    // 🧹 SANITIZE: Remove the wrapping ```markdown blocks
    newBibleContent = sanitizeMarkdown(newBibleContent);

    // 5. Update Story Bible in DynamoDB
    const dashboardRecord: ConstellationRecord = {
        PK: DASHBOARD_PK as any,
        SK: DASHBOARD_SK as any,
        id: "story_bible",
        type: "Dashboard",
        createdAt: existingDashboard?.createdAt || isoDate,
        updatedAt: isoDate,
        content: newBibleContent,
        isOriginal: false,
        mediaType: "text",
        lastAccessed: isoDate,
    };
    await saveRecord(dashboardRecord);

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: "Fiction entry processed successfully.",
        storyBible: newBibleContent
      }),
    };
  } catch (error: any) {
    console.error("Error in fiction handler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
