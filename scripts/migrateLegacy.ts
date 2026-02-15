import { Octokit } from "@octokit/rest";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ConstellationRecord, IntentRouterOutput, PineconeMetadata } from "../src/lib/schemas";
import KSUID from "ksuid";
import { getEmbedding } from "../src/utils";
import { Resource } from "sst";

// --- CONFIGURATION ---
const GITHUB_TOKEN = Resource.GITHUB_TOKEN.value;
const GITHUB_REPO_OWNER = Resource.GITHUB_OWNER.value;
const GITHUB_REPO_NAME = Resource.GITHUB_REPO.value;
const GEMINI_API_KEY = Resource.GEMINI_API_KEY.value;
const PINECONE_API_KEY = Resource.PINECONE_API_KEY.value;
const PINECONE_INDEX_HOST = Resource.PINECONE_INDEX_HOST.value;
const DYNAMODB_TABLE_NAME = Resource.UnifiedLake.name;
const AWS_REGION = "us-east-1";

// Allow overriding the user ID
const TARGET_USER_ID = process.env.MIGRATE_USER_ID || "migrated_user";
const PINECONE_INDEX_NAME = "brain-dump"; 

// Set Host for Serverless
process.env.PINECONE_INDEX_HOST = PINECONE_INDEX_HOST;

if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME || !GEMINI_API_KEY || !PINECONE_API_KEY || !DYNAMODB_TABLE_NAME) {
  throw new Error("Missing required resources. Run with `sst shell`.");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const INTENT_ROUTER_PROMPT = `
# System Prompt: Constellation Engine Intent Router

You are a hyper-efficient data processing engine. Analyze the input content and return a JSON object.

**RULES:**
1.  **Analyze Input:** Text, URL, or file content.
2.  **Determine Originality:** isOriginal: true if user's thoughts, false if external content.
3.  **Extract Source:** Populate sourceURL, sourceTitle, sourceAuthor if applicable.
4.  **Process Multimedia:** Detect 'audio' (transcription) or 'image' (description). Default 'text'.
5.  **Date Extraction:** If the content explicitly mentions a date (e.g., "Today is Jan 1st, 2025"), extract it as ISO string in 'extractedDate'. Otherwise null.
6.  **Output JSON ONLY:** Valid JSON matching the schema.

**JSON OUTPUT FORMAT:**
{
  "isOriginal": boolean,
  "sourceURL": string | null,
  "sourceTitle": string | null,
  "sourceAuthor": string | null,
  "content": string,
  "tags": string[],
  "mediaType": "text" | "audio" | "image",
  "extractedDate": string | null
}
`;

interface ExtendedIntentRouterOutput extends IntentRouterOutput {
    extractedDate?: string | null;
}

/**
 * Extracts date from filename or frontmatter.
 */
function extractDateFromMetadata(filePath: string, content: string): string | null {
    // 1. Try Frontmatter (YAML style: date: YYYY-MM-DD)
    const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
    const match = content.match(frontmatterRegex);
    if (match) {
        const frontmatter = match[1];
        const dateMatch = frontmatter.match(/date:\s*["']?(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?)["']?/);
        if (dateMatch) {
            return new Date(dateMatch[1]).toISOString();
        }
    }

    // 2. Try Filename (YYYY-MM-DD)
    const filenameRegex = /(\d{4}-\d{2}-\d{2})/; 
    const fileMatch = filePath.match(filenameRegex);
    if (fileMatch) {
        return new Date(fileMatch[1]).toISOString();
    }

    return null;
}

async function generateUnifiedMetadata(content: string): Promise<ExtendedIntentRouterOutput> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await model.generateContent(`${INTENT_ROUTER_PROMPT}\n\nINPUT:\n${content}`);
  const jsonText = result.response.text().replace(/```json\n?|\n?```/g, '').trim();
  return JSON.parse(jsonText) as ExtendedIntentRouterOutput;
}

async function fetchLegacyFiles(): Promise<{ path: string, content: string }[]> {
  console.log("Fetching legacy files from GitHub...");
  const files: { path: string, content: string }[] = [];

  async function traverse(path = "") {
    try {
        const { data } = await octokit.repos.getContent({
            owner: GITHUB_REPO_OWNER!,
            repo: GITHUB_REPO_NAME!,
            path,
        });

        if (Array.isArray(data)) {
            for (const item of data) {
                if (item.type === "file" && item.name.endsWith(".md")) {
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
    } catch (e) {
        console.error(`Error traversing path ${path}:`, e);
    }
  }

  await traverse("");
  console.log(`Found ${files.length} markdown files.`);
  return files;
}

async function cleanupPreviousMigration() {
    console.log(`Cleaning up previous migration for USER#${TARGET_USER_ID}...`);
    
    // 1. DynamoDB Cleanup
    let itemsToDelete: Record<string, any>[] = [];
    let lastEvaluatedKey;
    
    do {
        const command = new QueryCommand({
            TableName: DYNAMODB_TABLE_NAME,
            KeyConditionExpression: "PK = :pk",
            ExpressionAttributeValues: { ":pk": `USER#${TARGET_USER_ID}` },
            ExclusiveStartKey: lastEvaluatedKey
        });
        const result = await dynamoClient.send(command);
        if (result.Items) itemsToDelete.push(...result.Items);
        lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    console.log(`  -> Found ${itemsToDelete.length} items in DynamoDB.`);
    
    // Batch delete (chunk by 25)
    for (let i = 0; i < itemsToDelete.length; i += 25) {
        const batch = itemsToDelete.slice(i, i + 25);
        const promises = batch.map(item => dynamoClient.send(new DeleteCommand({
            TableName: DYNAMODB_TABLE_NAME,
            Key: { PK: item.PK, SK: item.SK }
        })));
        await Promise.all(promises);
    }
    console.log("  -> DynamoDB cleanup complete.");

    // 2. Pinecone Cleanup
    const index = pinecone.Index(PINECONE_INDEX_NAME).namespace("biography");
    try {
        await index.deleteMany({ filter: { userId: TARGET_USER_ID } });
        console.log("  -> Pinecone cleanup complete.");
    } catch (e) {
        console.warn("  -> Pinecone cleanup warning (might be empty):", e);
    }
}

export async function runLazarusMigration() {
  // await cleanupPreviousMigration(); // SKIPPING CLEANUP to preserve existing user data

  const legacyFiles = await fetchLegacyFiles();
  const index = pinecone.Index(PINECONE_INDEX_NAME).namespace("biography");

  for (const file of legacyFiles) {
    console.log(`Migrating: ${file.path}`);
    try {
      if (!file.content || !file.content.trim()) continue;

      // 1. Process Content
      const metadata = await generateUnifiedMetadata(file.content);
      
      // 2. Determine Date
      let createdAt = extractDateFromMetadata(file.path, file.content);
      if (!createdAt && metadata.extractedDate) {
          createdAt = metadata.extractedDate;
          console.log(`  -> Inferred date from content: ${createdAt}`);
      }
      if (!createdAt) {
          createdAt = new Date().toISOString();
          console.log(`  -> No date found, defaulting to NOW: ${createdAt}`);
      }

      const id = (await KSUID.random()).string;
      const userId = TARGET_USER_ID;

      // 3. Prepare DynamoDB record
      const record: ConstellationRecord = {
        PK: `USER#${userId}`,
        SK: `ENTRY#${id}`,
        id,
        type: 'Entry',
        createdAt: createdAt!,
        updatedAt: createdAt!, // Assume no updates since then
        lastAccessed: new Date().toISOString(), // Accessed now
        content: metadata.content,
        isOriginal: metadata.isOriginal ?? false,
        sourceURL: metadata.sourceURL || undefined,
        sourceTitle: metadata.sourceTitle || undefined,
        sourceAuthor: metadata.sourceAuthor || undefined,
        mediaType: metadata.mediaType || "text",
        tags: metadata.tags || [],
        skipBackup: true,
      };
      
      await dynamoClient.send(new PutCommand({
        TableName: DYNAMODB_TABLE_NAME,
        Item: record,
      }));

      // 4. Pinecone
      const vector = await getEmbedding(metadata.content);
      const pineconeMetadata: PineconeMetadata = {
        id,
        userId,
        isOriginal: metadata.isOriginal ?? false,
        mediaType: metadata.mediaType || "text",
        createdAt: createdAt!,
        tags: metadata.tags || [],
      };

      await index.upsert([
        {
          id: id,
          values: vector,
          metadata: pineconeMetadata as unknown as Record<string, any>
        }
      ]);

      console.log(`  -> Successfully migrated ${id} (Date: ${createdAt})`);
    } catch (error) {
      console.error(`  -> FAILED to migrate ${file.path}:`, error);
    }
  }
}

runLazarusMigration();