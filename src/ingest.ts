import { GoogleGenerativeAI } from "@google/generative-ai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";
import KSUID from "ksuid";
import { getEmbedding, upsertToPinecone } from "./utils";
import type { ConstellationRecord, IntentRouterOutput, PineconeMetadata } from "./lib/schemas";

// Initialize Clients
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Environment
const PINECONE_INDEX_NAME = "brain-dump"; // Or typically Resource.PineconeIndex.value if managed
const TABLE_NAME = Resource.UnifiedLake.name;

const INTENT_ROUTER_PROMPT = `
# System Prompt: Constellation Engine Intent Router

You are a hyper-efficient data processing engine for a 'Second Brain' application. Your sole purpose is to receive a piece of content, analyze it, and return a structured JSON object.

**RULES:**
1.  **Analyze the Input:** The user will provide a block of text, a URL, or a reference to an uploaded file.
2.  **Determine Originality:**
    *   If the content appears to be the user's own thoughts, set \`isOriginal: true\`.
    *   If it contains quotes, is a direct paste from a web article, or is a URL, set \`isOriginal: false\`.
3.  **Extract Source (if \`isOriginal: false\`):**
    *   If a URL is present, populate \`sourceURL\`.
    *   Attempt to identify \`sourceTitle\` and \`sourceAuthor\` from the text if available.
4.  **Process Multimedia:**
    *   **For Audio:** Assume the input is a transcription. Extract the core message into \`content\`. Generate \`tags\` describing the emotional tone (e.g., "emotional_tone: excited"). Set \`mediaType: 'audio'\`.
    *   **For Images:** Assume the input is a description of an image. Summarize the description into \`content\`. Generate \`tags\` describing the key visual concepts (e.g., "concept: UML Diagram", "style: hand-drawn"). Set \`mediaType: 'image'\`.
    *   **For Text:** The input is the content. Set \`mediaType: 'text'\`.
5.  **Output JSON ONLY:** Your entire response MUST be a single, valid JSON object matching the \`IntentRouterOutput\` interface. Do not include any explanations or conversational text.

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

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    // 1. Authentication
    const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
    if (!userId) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: "Request body is empty." }) };
    }

    const { content: rawInput } = JSON.parse(event.body);
    if (!rawInput) {
       return { statusCode: 400, body: JSON.stringify({ message: "Content is required." }) };
    }

    // 2. Intent Router (Classification & Extraction)
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Fast model for routing
    const result = await model.generateContent(`${INTENT_ROUTER_PROMPT}\n\nINPUT:\n${rawInput}`);
    const responseText = result.response.text().replace(/```json\n?|\n?```/g, '').trim();
    const routerOutput = JSON.parse(responseText) as IntentRouterOutput;

    // 3. ID Generation
    const id = (await KSUID.random()).string;
    const now = new Date().toISOString();

    // 4. Prepare DynamoDB Record
    const record: ConstellationRecord = {
      PK: `USER#${userId}`,
      SK: `ENTRY#${id}`,
      id,
      type: "Entry",
      createdAt: now,
      updatedAt: now,
      content: routerOutput.content,
      isOriginal: routerOutput.isOriginal,
      sourceURL: routerOutput.sourceURL || undefined,
      sourceTitle: routerOutput.sourceTitle || undefined,
      sourceAuthor: routerOutput.sourceAuthor || undefined,
      mediaType: routerOutput.mediaType,
      tags: routerOutput.tags,
      lastAccessed: now,
    };

    // 5. Save to DynamoDB
    await dynamoClient.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: record,
    }));

    // 6. Generate Embedding
    const vector = await getEmbedding(routerOutput.content);

    // 7. Save to Pinecone
    const pineconeMetadata: PineconeMetadata = {
      id,
      userId: userId as string,
      isOriginal: routerOutput.isOriginal,
      mediaType: routerOutput.mediaType,
      createdAt: now,
      tags: routerOutput.tags,
    };

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      id,
      vector,
      pineconeMetadata as unknown as Record<string, any>
    );

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Ingested successfully", id, routerOutput }),
    };

  } catch (error: any) {
    console.error("Ingestion Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal Server Error", error: error.message }),
    };
  }
}
