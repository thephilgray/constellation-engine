import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, queryPinecone, sanitizeMarkdown } from "./utils";
import { saveRecord, getRecord } from "./lib/dynamo";
import type { ConstellationRecord } from "./lib/schemas";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const PINECONE_INDEX_NAME = "brain-dump";
const IDEAS_NAMESPACE = "ideas";
const DASHBOARD_PK = "DASHBOARD#idea_garden";
const DASHBOARD_SK = "STATE";

const initialIdeaGardenContent = `# 🧠 The Idea Garden
*A living synthesis of your intellectual evolution.*

## 🔭 Current Obsessions
- **Focus:** Exploring the system.
- **Key Concepts:** None yet.

## 🧩 The Synthesis (Current Theory)
The user has begun cultivating their garden of ideas. The soil is fresh, waiting for the first seeds of thought to be planted.

## ❓ Open Questions
*(No questions posed yet.)*`;

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    // Authentication
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    const expectedApiKey = `Bearer ${Resource.INGEST_API_KEY.value}`;
    const isApiKeyValid = authHeader === expectedApiKey;
    const isCognitoValid = !!event.requestContext.authorizer?.jwt;

    if (!isApiKeyValid && !isCognitoValid) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    // Extract User ID (if Cognito)
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub as string || "default-user";

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: "Request body is empty." }) };
    }

    // 1. Ingest
    const { content }: { content: string } = JSON.parse(event.body);

    if (!content) {
      return { statusCode: 400, body: JSON.stringify({ message: "Content is required." }) };
    }

    // 2. Embed & Save (Namespace: ideas)
    const vector = await getEmbedding(content);
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const isoDate = date.toISOString();
    const entryId = `idea-${timestamp}`;

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      entryId,
      vector,
      { text: content, tag: "THOUGHT", date: isoDate, userId },
      IDEAS_NAMESPACE
    );

    // Save Entry to DynamoDB (Unified Lake)
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
        tags: ["thought"],
        lastAccessed: isoDate,
    };
    await saveRecord(entryRecord);

    // 3. Recall Context
    const similarEntries = await queryPinecone(PINECONE_INDEX_NAME, vector, 5, IDEAS_NAMESPACE);
    const contextEntries = similarEntries.matches
      .map(m => `- "${m.metadata?.text}" `)
      .join("\n");

    // 4. The Architect Logic (Gemini 2.0 Flash)
    // Fetch current dashboard state from DynamoDB
    let gardenContent = initialIdeaGardenContent;
    const existingDashboard = await getRecord(DASHBOARD_PK, DASHBOARD_SK);
    
    if (existingDashboard && existingDashboard.content) {
        gardenContent = existingDashboard.content;
    }

    const systemPrompt = `
    You are The Architect (Intellectual Biographer). You are rewriting the "Idea Garden" dashboard to reflect the user's latest thought.

    **Goal:** Update the dashboard to evolve the narrative of the user's intellectual journey. 
    **Do NOT just append text.** Reformulate the existing text to weave the new idea into the bigger picture.

    **Input Data:**
    - **New Thought:** "${content}"
    - **Context (Related Ideas):** 
${contextEntries}

    **Current Dashboard State:**
    ${gardenContent}

    **Instructions for Updates:**

    1.  **## 🔭 Current Obsessions:** 
        - Update **Focus** and **Key Concepts** based on the *new thought*.
        - If the new thought signals a shift in interest, reflect that here.

    2.  **## 🧩 The Synthesis (Current Theory):**
        - This is the core narrative (3-4 paragraphs max).
        - **Rewrite** this section to synthesize the New Thought with the previous state.
        - Connect the dots. How does this new idea modify, reinforce, or contradict previous ones?
        - Create a cohesive "Thread of Thought" rather than a list of disconnected ideas.

    3.  **## ❓ Open Questions:**
        - Did the New Thought raise a question? If so, add it.
        - If a previous question was answered by this thought, remove it.

    **Output:**
    - Return the **FULL** Markdown file content.
    - Do not use markdown code blocks (
    `;

    const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await generativeModel.generateContent(systemPrompt);
    const newGardenContent = sanitizeMarkdown(result.response.text());

    // 5. Update Dashboard in Unified Lake (DynamoDB)
    const dashboardRecord: ConstellationRecord = {
        PK: DASHBOARD_PK as any,
        SK: DASHBOARD_SK as any,
        id: "idea_garden",
        type: "Dashboard",
        createdAt: existingDashboard?.createdAt || isoDate,
        updatedAt: isoDate,
        content: newGardenContent,
        isOriginal: false,
        mediaType: "text",
        lastAccessed: isoDate,
    };
    await saveRecord(dashboardRecord);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Thought processed and Idea Garden updated.",
        garden: newGardenContent
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