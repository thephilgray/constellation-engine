# Refactoring & Migration Plan: Constellation Engine - Unified Lake Architecture

This document outlines the refactoring and migration plan to transform the "Constellation Engine" into a "Unified Lake" architecture, based on the provided requirements and codebase analysis.

## 1. The Schemas: Unified Data Model

We will implement a Single-Table Design in DynamoDB for efficient and diverse data access patterns. Pinecone's metadata will mirror the searchable fields.

**File:** `src/lib/schemas.ts` (new file)

```typescript
// src/lib/schemas.ts

/**
 * The primary schema for the Unified Lake in DynamoDB.
 * Uses Single-Table Design principles.
 */
export interface ConstellationRecord {
  // Core Keys
  PK: `USER#${string}`;
  SK: `ENTRY#${string}` | `METADATA`;

  // Universal Attributes
  id: string;
  type: 'Entry' | 'User';
  createdAt: string;
  updatedAt: string;

  // --- Entry-Specific Attributes (present if type === 'Entry') ---

  // Core Content
  content: string;
  
  // Origin Protocol
  isOriginal: boolean;
  sourceURL?: string;
  sourceTitle?: string;
  sourceAuthor?: string;

  // Multimedia & Ingestion
  mediaType?: 'text' | 'audio' | 'image';
  s3_url?: string;
  tags?: string[];

  // Incubator
  lastAccessed: string;
}

/**
 * Metadata stored in Pinecone alongside the vector embedding.
 * This is a subset of the DynamoDB record, used for filtering searches.
 */
export interface PineconeMetadata {
  id: string;
  userId: string;
  isOriginal: boolean;
  mediaType: 'text' | 'audio' | 'image';
  createdAt: string;
  tags: string[];
}

/**
 * The structured output expected from the "Intent Router" LLM call.
 */
export interface IntentRouterOutput {
  isOriginal: boolean;
  sourceURL?: string;
  sourceTitle?: string;
  sourceAuthor?: string;
  content: string;
  tags: string[];
  mediaType: 'text' | 'audio' | 'image';
}
```

## 2. The System Prompt: "Intent Router"

This prompt is designed for `gemini-3-flash` to quickly and accurately classify and structure incoming data.

```text
# System Prompt: Constellation Engine Intent Router

You are a hyper-efficient data processing engine for a 'Second Brain' application. Your sole purpose is to receive a piece of content, analyze it, and return a structured JSON object.

**RULES:**
1.  **Analyze the Input:** The user will provide a block of text, a URL, or a reference to an uploaded file.
2.  **Determine Originality:**
    *   If the content appears to be the user's own thoughts, set `isOriginal: true`.
    *   If it contains quotes, is a direct paste from a web article, or is a URL, set `isOriginal: false`.
3.  **Extract Source (if `isOriginal: false`):**
    *   If a URL is present, populate `sourceURL`.
    *   Attempt to identify `sourceTitle` and `sourceAuthor` from the text if available.
4.  **Process Multimedia:**
    *   **For Audio:** Assume the input is a transcription. Extract the core message into `content`. Generate `tags` describing the emotional tone (e.g., "emotional_tone: excited"). Set `mediaType: 'audio'`.
    *   **For Images:** Assume the input is a description of an image. Summarize the description into `content`. Generate `tags` describing the key visual concepts (e.g., "concept: UML Diagram", "style: hand-drawn"). Set `mediaType: 'image'`.
    *   **For Text:** The input is the content. Set `mediaType: 'text'`.
5.  **Output JSON ONLY:** Your entire response MUST be a single, valid JSON object matching the `IntentRouterOutput` interface. Do not include any explanations or conversational text.

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
```

## 3. The "Lazarus" Migration Script

This script will read from your existing GitHub repository and populate the new DynamoDB table and Pinecone index.

**File:** `scripts/migrateLegacy.ts` (new file)

```typescript
import { Octokit } from "octokit";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleGenerativeAI } from "@google-generative-ai";
import type { ConstellationRecord, IntentRouterOutput } from "../src/lib/schemas";
import { KSUID } from "ksuid"; // A good choice for sortable, unique IDs.

// --- CONFIGURATION ---
// These values are injected by `sst run`. See .env.d.ts for type definitions.
const GITHUB_TOKEN = process.env.SST_SECRET_GITHUB_TOKEN;
const GITHUB_REPO_OWNER = process.env.SST_SECRET_GITHUB_OWNER;
const GITHUB_REPO_NAME = process.env.SST_SECRET_GITHUB_REPO;
const GEMINI_API_KEY = process.env.SST_SECRET_GEMINI_API_KEY;
const PINECONE_API_KEY = process.env.SST_SECRET_PINECONE_API_KEY;
const DYNAMODB_TABLE_NAME = process.env.SST_TABLE_tableName_UnifiedLake;
const AWS_REGION = "us-east-1";

// Validate that all necessary environment variables are set
if (!GITHUB_TOKEN || !GITHUB_REPO_OWNER || !GITHUB_REPO_NAME || !GEMINI_API_KEY || !PINECONE_API_KEY || !DYNAMODB_TABLE_NAME) {
  throw new Error(
    "One or more required environment variables are missing. " +
    "Ensure you are running this script with `sst run` and that all secrets are configured."
  );
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * Uses the Intent Router prompt to process raw text content.
 */
async function generateUnifiedMetadata(content: string): Promise<IntentRouterOutput> {
  const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" }); // Or your fine-tuned model
  const prompt = `... The Intent Router System Prompt ...\n\nINPUT:\n${content}`;
  
  const result = await model.generateContent(prompt);
  const jsonText = result.response.text().replace(/```json\n?|\n?```/g, '');
  return JSON.parse(jsonText) as IntentRouterOutput;
}

/**
 * Fetches all markdown files from the legacy GitHub repository.
 */
async function fetchLegacyFiles(): Promise<{path: string, content: string}[]> {
  // Logic to recursively fetch all .md files from the repo using octokit.
  // For example, using `octokit.git.getTree` and `octokit.git.getBlob`.
  console.log("Fetching legacy files from GitHub...");
  // This is a placeholder for the actual implementation.
  return []; 
}

/**
 * Main migration function.
 */
export async function runLazarusMigration() {
  const legacyFiles = await fetchLegacyFiles();
  const pineconeIndex = pinecone.index("constellation"); // Your Pinecone index name

  for (const file of legacyFiles) {
    console.log(`Migrating: ${file.path}`);
    try {
      const metadata = await generateUnifiedMetadata(file.content);
      const id = (await KSUID.random()).string;
      const now = new Date().toISOString();

      // 1. Prepare DynamoDB record
      const record: ConstellationRecord = {
        PK: "USER#manual_user", // Assuming one user for now
        SK: `ENTRY#${now}`,
        id,
        type: 'Entry',
        createdAt: now,
        updatedAt: now,
        lastAccessed: now,
        content: metadata.content,
        isOriginal: metadata.isOriginal,
        sourceURL: metadata.sourceURL,
        sourceTitle: metadata.sourceTitle,
        sourceAuthor: metadata.sourceAuthor,
        mediaType: metadata.mediaType,
        tags: metadata.tags,
      };
      
      // 2. Save to DynamoDB
      await dynamoClient.send(new PutCommand({
        TableName: DYNAMODB_TABLE_NAME,
        Item: record,
      }));

      // 3. Get embedding and save to Pinecone
      const embedding = [0.1, 0.2, /* ... actual embedding values ... */]; // Placeholder for getEmbedding(metadata.content)
      await pineconeIndex.upsert([
        {
          id: id,
          values: embedding,
          metadata: {
            id: id,
            userId: "manual_user",
            isOriginal: metadata.isOriginal,
            mediaType: metadata.mediaType,
            createdAt: now,
            tags: metadata.tags,
          }
        }
      ]);

      console.log(`  -> Successfully migrated ${id}`);
    } catch (error) {
      console.error(`  -> FAILED to migrate ${file.path}:`, error);
    }
  }
}

// To run: `sst run npx tsx scripts/migrateLegacy.ts`
// runLazarusMigration();
```

## 4. The SST Config Plan (Revised for Project Syntax)

This plan details the modifications for your `sst.config.ts` file, adhering to the established `$config` and `async run()` structure.

```typescript
// sst.config.ts

/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    // ... (no changes here)
  },
  async run() {
    // === EXISTING SECRET DEFINITIONS ===
    const GEMINI_API_KEY = new sst.Secret("GEMINI_API_KEY");
    // ... all other secrets
    const GOOGLE_BOOKS_API_KEY = new sst.Secret("GOOGLE_BOOKS_API_KEY");

    // === NEW UNIFIED LAKE RESOURCES ===

    // 4. Authentication
    const auth = new sst.aws.CognitoUserPool("Auth", {
      selfSignUps: {
        email: {
          // You might need to configure verification, etc.
        },
      },
    });
    // Add a client for the user pool
    const authClient = auth.addClient("WebApp");

    // 2. Multimedia Storage
    const bucket = new sst.aws.Bucket("AssetBucket");

    // 3. The Unified Lake: DynamoDB Table
    const table = new sst.aws.Dynamo("UnifiedLake", {
      fields: {
        PK: "string",
        SK: "string",
      },
      primaryIndex: { hashKey: "PK", rangeKey: "SK" },
      stream: "new_image",
    });

    // 4. The "Legacy" Archive Worker (Triggered by DynamoDB Stream)
    const githubBackupWorker = new sst.aws.Function("GitHubBackupWorker", {
      handler: "src/workers/githubBackup.handler", // New worker file
      link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO],
    });

    // Subscribe the worker to the table's stream
    table.subscribe(githubBackupWorker, {
      filters: [
        { dynamodb: { NewImage: { type: { S: ["Entry"] } } } }
      ]
    });


    // === UPDATED & EXISTING FUNCTIONS ===

    // LIBRARIAN WORKFLOW (no changes to state machine, but functions need new `table` link)
    const librarianFunctions = {
        fetchContext: new sst.aws.Function("LibrarianFetchContext", {
            // ... existing config
            link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, table], // Add table link
        }),
        // ... repeat for all other librarianFunctions, adding `table` to the `link` array
        persistRecs: new sst.aws.Function("LibrarianPersistRecs", {
            // ... existing config
            link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, table], // Add table link
        }),
    };
    // ... (rest of the Step Functions definition is unchanged)


    // 5. SECURED INGESTION ENDPOINT
    const ingest = new sst.aws.Function("Ingest", {
      handler: "src/ingest.handler",
      timeout: "60 seconds",
      // Link all resources, including the new ones
      link: [
        table,
        bucket,
        auth,
        GEMINI_API_KEY, 
        PINECONE_API_KEY, 
        PINECONE_INDEX_HOST, 
        GITHUB_TOKEN, 
        GITHUB_OWNER, 
        GITHUB_REPO, 
        INGEST_API_KEY
      ],
      // Secure the public URL with the Cognito authorizer
      url: {
        authorizer: {
          jwt: {
            issuer: auth.issuer,
            audiences: [auth.userPoolClientId],
          },
        },
      },
    });

    // Other functions (dream, lyrics, etc.) can be similarly secured if needed
    // by adding the `url.authorizer` block and linking `auth`.

    // ... (rest of your existing functions)

    return {
      ingestEndpoint: ingest.url,
      // ... other existing outputs
    };
  },
});
```