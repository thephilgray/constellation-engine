import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, appendToFile, getFile, createOrUpdateFile, queryPinecone, sanitizeMarkdown } from "./utils";

// Set environment for Pinecone Serverless
process.env.PINECONE_INDEX_HOST = Resource.PINECONE_INDEX_HOST.value;

// Initialize clients
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const PINECONE_INDEX_NAME = "brain-dump";
const DASHBOARD_FILE_PATH = "00_Current_Constellations.md";

type InputType = "IDEA" | "DRAFT" | "SOURCE";

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // API Key Authentication
    const authHeader = event.headers.authorization;
    const expectedApiKey = `Bearer ${Resource.INGEST_API_KEY.value}`;
    if (authHeader !== expectedApiKey) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: "Request body is empty." }) };
    }

    // 1. Receive Input
    const { content: newThought, type = "IDEA" }: { content: string; type?: InputType } = JSON.parse(event.body);

    // 2. Embed
    const vector = await getEmbedding(newThought);

    // 3. Persist (Write)
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const isoDate = date.toISOString().split('T')[0];

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      `thought-${timestamp}`,
      vector,
      { text: newThought, type, timestamp, date: isoDate }
    );

    // Create backup in GitHub
    let archivePath: string;
    const fileName = `${isoDate}-${timestamp}.md`;
    switch (type) {
      case "DRAFT":
        archivePath = `Drafts/${fileName}`;
        break;
      case "SOURCE":
        archivePath = `References/${fileName}`;
        break;
      case "IDEA":
      default:
        archivePath = `_Archive/${fileName}`;
        break;
    }

    await appendToFile(archivePath, newThought, `archive: ${type} - ${isoDate}`);

    // 4. Recall (Read)
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recentResults = await queryPinecone(
      PINECONE_INDEX_NAME,
      vector,
      100,
      undefined,
      { timestamp: { $gte: fourteenDaysAgo } }
    );

    const relevantResults = await queryPinecone(
      PINECONE_INDEX_NAME,
      vector,
      10
    );

    const contextThoughts = [...recentResults.matches, ...relevantResults.matches]
      .filter((match, index, self) =>
        match.metadata?.text && self.findIndex(m => m.id === match.id) === index
      )
      .map(m => `[${m.metadata?.type || 'IDEA'}] "${m.metadata?.text}"`)
      .join("\n- ");

    const contextString = `Contextual thoughts:\n- ${contextThoughts}`;

    // 5. Fetch State
    const { content: currentDashboardContent } = await getFile(DASHBOARD_FILE_PATH);

    // 6. Synthesize (The "Gardener")
    const generativeModel = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
    const systemPrompt = `
      You are a Knowledge Gardener. Your task is to integrate a new thought into a living markdown document of thematic clusters called "Constellations". You are managing a Dashboard of the user's writing topics. You have 3 input types:
      - **IDEAS:** Raw thoughts. Cluster them freely.
      - **DRAFTS:** Actual writing. These indicate the user is ACTIVELY working on a topic. Give it higher priority.
      - **SOURCES:** External quotes/links. These are EVIDENCE. Never create a Constellation based on a source title. Only use sources to support existing themes.

      **Current Dashboard State:**
      ${currentDashboardContent}

      **New Thought:**
      "[${type}] ${newThought}"

      **Context from related thoughts:**
      ${contextString}

      **Rules:**
      - If the input is a DRAFT, find the matching Constellation and add a sub-header: ### 📝 Active Draft: [One line summary].
      - If the input is a SOURCE, find the matching Constellation and add a bullet point: * 📎 Ref: [Summary of source].
      - **The Graveyard Rule:** If a topic exists in the "## 🪦 Archived" section of the Current Dashboard, DO NOT generate a new Constellation for it. Ignore those thoughts.
      - **Stability Constraint:** Prefer appending to existing themes over creating new ones or renaming them. Only refactor if the new thought radically changes the context or bridges two previously separate ideas.
      - Maintain the exact markdown structure.
      - **IMPORTANT:** Output RAW markdown only. Do not wrap the output in markdown code blocks. Do not include any conversational text.
    `;

    const result = await generativeModel.generateContent(systemPrompt);
    let newDashboardContent = result.response.text();

    // 🧹 SANITIZE: Remove the wrapping ```markdown blocks
    newDashboardContent = sanitizeMarkdown(newDashboardContent);

    // 7. Update
    await createOrUpdateFile(DASHBOARD_FILE_PATH, newDashboardContent, "garden: Integrate new thought");

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Ingestion successful." }),
    };
  } catch (error: any) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
