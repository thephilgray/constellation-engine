import { GoogleGenerativeAI } from "@google/generative-ai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";
import KSUID from "ksuid";
import { getEmbedding, upsertToPinecone, queryPinecone } from "./utils";
import { INTENT_ROUTER_SYSTEM_PROMPT, RAG_SYSTEM_PROMPT } from "./lib/prompts";
import type { ConstellationRecord, IntentRouterOutput, PineconeMetadata } from "./lib/schemas";

// Initialize Clients
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Environment
const PINECONE_INDEX_NAME = "brain-dump";
const TABLE_NAME = Resource.UnifiedLake.name;

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
    const result = await model.generateContent(`${INTENT_ROUTER_SYSTEM_PROMPT}\n\nINPUT:\n${rawInput}`);
    const responseText = result.response.text().replace(/```json\n?|\n?```/g, '').trim();
    const routerOutput = JSON.parse(responseText) as IntentRouterOutput;

    // ---------------------------------------------------------
    // BRANCH A: QUERY (The Incubator)
    // ---------------------------------------------------------
    if (routerOutput.intent === 'query') {
      console.log("Processing Query:", routerOutput.content);

      // 1. Generate Embedding for the query
      const vector = await getEmbedding(routerOutput.content);

      // 2. Query Pinecone for Context
      // Filter by userId to ensure privacy
      const queryResponse = await queryPinecone(
        PINECONE_INDEX_NAME, 
        vector, 
        10, 
        undefined, 
        { userId: userId } 
      );
      
      const matches = queryResponse.matches || [];
      const contextIds = matches.map(m => m.id);

      // 3. Fetch Full Content from DynamoDB (if matches found)
      let contextText = "";
      
      if (contextIds.length > 0) {
        const keys = contextIds.map(id => ({
          PK: `USER#${userId}`,
          SK: `ENTRY#${id}`
        }));

        const batchGet = await dynamoClient.send(new BatchGetCommand({
          RequestItems: {
            [TABLE_NAME]: {
              Keys: keys,
              ProjectionExpression: "content, sourceTitle, createdAt" // Fetch only needed fields
            }
          }
        }));
        
        const foundItems = batchGet.Responses?.[TABLE_NAME] || [];
        
        contextText = foundItems.map((item: any) => 
          `--- ENTRY (Date: ${item.createdAt}, Title: ${item.sourceTitle || 'Untitled'}) ---\n${item.content}`
        ).join("\n\n");
      }

      // 4. Synthesize Answer with Gemini
      const ragModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" }); // Or 1.5-pro
      const ragPrompt = `${RAG_SYSTEM_PROMPT}\n\nUSER QUESTION:\n${routerOutput.content}\n\nRETRIEVED CONTEXT:\n${contextText || "No relevant context found."}`;
      
      const ragResult = await ragModel.generateContent(ragPrompt);
      const answer = ragResult.response.text();

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Query processed", 
          intent: 'query',
          answer: answer,
          contextIds 
        }),
      };
    }

    // ---------------------------------------------------------
    // BRANCH B: SAVE (The Recorder)
    // ---------------------------------------------------------
    // Default to 'save' if intent is missing or explicitly 'save'
    
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
      body: JSON.stringify({
        message: "Ingested successfully", 
        intent: 'save',
        id, 
        routerOutput 
      }),
    };

  } catch (error: any) {
    console.error("Ingestion Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Internal Server Error", error: error.message }),
    };
  }
}