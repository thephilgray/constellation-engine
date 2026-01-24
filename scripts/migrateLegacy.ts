import { Octokit } from "@octokit/rest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ConstellationRecord, IntentRouterOutput, PineconeMetadata } from "../src/lib/schemas";
import KSUID from "ksuid";
import { getEmbedding } from "../src/utils";
import { Resource } from "sst";

// --- CONFIGURATION ---
// Access resources directly from the SST Resource object
const GITHUB_TOKEN = Resource.GITHUB_TOKEN.value;
const GITHUB_REPO_OWNER = Resource.GITHUB_OWNER.value;
const GITHUB_REPO_NAME = Resource.GITHUB_REPO.value;
const GEMINI_API_KEY = Resource.GEMINI_API_KEY.value;
const PINECONE_API_KEY = Resource.PINECONE_API_KEY.value;
const PINECONE_INDEX_HOST = Resource.PINECONE_INDEX_HOST.value;
const DYNAMODB_TABLE_NAME = Resource.UnifiedLake.name;
const AWS_REGION = "us-east-1"; // Hardcoded for now, can be made dynamic if needed

// Validate
if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME || !GEMINI_API_KEY || !PINECONE_API_KEY || !DYNAMODB_TABLE_NAME) {
  throw new Error(
    "One or more required resources could not be loaded. " +
    "Ensure you are running this script with `sst shell` and that all secrets are configured."
  );
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const PINECONE_INDEX_NAME = "brain-dump"; // Assuming this is your index name

// Set Host for Serverless - this is still necessary for the Pinecone client to pick it up
process.env.PINECONE_INDEX_HOST = PINECONE_INDEX_HOST;

const INTENT_ROUTER_PROMPT = `
# System Prompt: Constellation Engine Intent Router

You are a hyper-efficient data processing engine for a 'Second Brain' application. Your sole purpose is to receive a piece of content, analyze it, and return a structured JSON object.

**RULES:**
1.  **Analyze the Input:** The user will provide a block of text, a URL, or a reference to an uploaded file.
2.  **Determine Originality:**
    *   If the content appears to be the user's own thoughts, set isOriginal: true.
    *   If it contains quotes, is a direct paste from a web article, or is a URL, set isOriginal: false.
3.  **Extract Source (if isOriginal: false):**
    *   If a URL is present, populate sourceURL.
    *   Attempt to identify sourceTitle and sourceAuthor from the text if available.
4.  **Process Multimedia:**
    *   **For Audio:** Assume the input is a transcription. Extract the core message into content. Generate tags describing the emotional tone (e.g., "emotional_tone: excited"). Set mediaType: 'audio'.
    *   **For Images:** Assume the input is a description of an image. Summarize the description into content. Generate tags describing the key visual concepts (e.g., "concept: UML Diagram", "style: hand-drawn"). Set mediaType: 'image'.
    *   **For Text:** The input is the content. Set mediaType: 'text'.
5.  **Output JSON ONLY:** Your entire response MUST be a single, valid JSON object matching the IntentRouterOutput interface. Do not include any explanations or conversational text.

**JSON OUTPUT FORMAT:**
{
  "isOriginal": boolean,
  "sourceURL": string | null,
  "sourceTitle": string | null,
  "sourceAuthor": string | null,
  "content": string,
  "tags": string[],
  "mediaType": "text" | "audio" | "image"
}
`;

/**
 * Uses the Intent Router prompt to process raw text content.
 */
async function generateUnifiedMetadata(content: string): Promise<IntentRouterOutput> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const result = await model.generateContent(`${INTENT_ROUTER_PROMPT}\n\nINPUT:\n${content}`);
  const jsonText = result.response.text().replace(/```json\n?|\n?```/g, '').trim();
  return JSON.parse(jsonText) as IntentRouterOutput;
}

/**
 * Recursively fetches all markdown files from the legacy GitHub repository.
 */
async function fetchLegacyFiles(): Promise<{ path: string, content: string }[]> {
  console.log("Fetching legacy files from GitHub...");
  const files: { path: string, content: string }[] = [];

  async function traverse(path = "") {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_REPO_OWNER!,
      repo: GITHUB_REPO_NAME!,
      path,
    });

    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.type === "file" && item.name.endsWith(".md")) {
          // Fetch content
          const fileData = await octokit.repos.getContent({
            owner: GITHUB_REPO_OWNER!,
            repo: GITHUB_REPO_NAME!,
            path: item.path,
          });
          
          if ("content" in fileData.data) {
             const content = Buffer.from(fileData.data.content, "base64").toString("utf-8");
             files.push({ path: item.path, content });
          }
        } else if (item.type === "dir") {
          await traverse(item.path);
        }
      }
    }
  }

  await traverse(""); // Start from the root of the repo
  console.log(`Found ${files.length} markdown files.`);
  return files;
}

/**
 * Main migration function.
 */
export async function runLazarusMigration() {
  const legacyFiles = await fetchLegacyFiles();
  const index = pinecone.Index(PINECONE_INDEX_NAME);

  for (const file of legacyFiles) {
    console.log(`Migrating: ${file.path}`);
    try {
      // 0. Validate Content
      if (!file.content || !file.content.trim()) {
        console.log(`  -> SKIPPING: Content is empty.`);
        continue;
      }

      // 1. Process Content
      const metadata = await generateUnifiedMetadata(file.content);
      const id = (await KSUID.random()).string;
      const now = new Date().toISOString();
      const userId = "migrated_user"; // Default user ID for legacy data

      // 2. Prepare DynamoDB record
      const record: ConstellationRecord = {
        PK: `USER#${userId}`,
        SK: `ENTRY#${id}`,
        id,
        type: 'Entry',
        createdAt: now,
        updatedAt: now,
        lastAccessed: now,
        content: metadata.content,
        isOriginal: metadata.isOriginal ?? false, // Ensure boolean
        sourceURL: metadata.sourceURL || undefined,
        sourceTitle: metadata.sourceTitle || undefined,
        sourceAuthor: metadata.sourceAuthor || undefined,
        mediaType: metadata.mediaType || "text",
        tags: metadata.tags || [],
        skipBackup: true,
      };
      
      // 3. Save to DynamoDB
      await dynamoClient.send(new PutCommand({
        TableName: DYNAMODB_TABLE_NAME,
        Item: record,
      }));

      // 4. Generate Embedding and save to Pinecone
      const vector = await getEmbedding(metadata.content);
      
      const pineconeMetadata: PineconeMetadata = {
        id,
        userId,
        isOriginal: metadata.isOriginal ?? false, // Ensure boolean (no nulls for Pinecone)
        mediaType: metadata.mediaType || "text",
        createdAt: now,
        tags: metadata.tags || [],
      };

      await index.upsert([
        {
          id: id,
          values: vector,
          metadata: pineconeMetadata as unknown as Record<string, any>
        }
      ]);

      console.log(`  -> Successfully migrated ${id}`);
    } catch (error) {
      console.error(`  -> FAILED to migrate ${file.path}:`, error);
    }
  }
}

// Execute
runLazarusMigration();
