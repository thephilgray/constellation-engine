import { GoogleGenerativeAI } from "@google/generative-ai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, BatchGetCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";
import KSUID from "ksuid";
import { getEmbedding, upsertToPinecone, queryPinecone } from "./utils";
import { INTENT_ROUTER_SYSTEM_PROMPT, RAG_SYSTEM_PROMPT } from "./lib/prompts";
import type { ConstellationRecord, IntentRouterOutput, PineconeMetadata } from "./lib/schemas";
import { updateReadingList } from "./librarian/logBook";

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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }); // Fast model for routing
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

      // 2. Query Pinecone (All Namespaces)
      // We search all specialized memory compartments to form a holistic answer.
      const namespaces = ['', 'biography', 'dreams', 'fiction', 'lyrics', 'ideas'];
      const searchPromises = namespaces.map(ns => 
        queryPinecone(PINECONE_INDEX_NAME, vector, 5, ns || undefined, { userId: userId })
          .then(res => res.matches?.map(m => ({ ...m, _namespace: ns })) || [])
      );

      const allMatches = (await Promise.all(searchPromises)).flat();

      // Sort by score (descending) and take top 15
      const sortedMatches = allMatches
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 15);

      const contextIds = sortedMatches.map(m => m.id);

      // 3. Construct Context (Prefer Metadata, Fallback to DynamoDB)
      let contextEntries: string[] = [];
      let contextSources: { id: string; title?: string; url?: string; score?: number }[] = [];
      
      // IDs that need fetching from DynamoDB (missing metadata text)
      const missingContentIds: string[] = [];

      for (const match of sortedMatches) {
          const meta = match.metadata as unknown as PineconeMetadata;
          const score = match.score ? match.score.toFixed(2) : "?";
          const source = `[${match._namespace || 'general'} | ${score}]`;

          if (meta && meta.text) {
              // Found in metadata (Fast Path)
              contextEntries.push(`--- ENTRY ${source} ---\n${meta.text}`);
              contextSources.push({
                  id: match.id,
                  title: (meta as any).title || "Memory",
                  score: match.score
              });
          } else {
              // Need to fetch from DB
              missingContentIds.push(match.id);
          }
      }
      
      // Fetch missing content from DynamoDB
      if (missingContentIds.length > 0) {
        const keys = missingContentIds.map(id => ({
          PK: `USER#${userId}`,
          SK: `ENTRY#${id}`
        }));

        try {
            const batchGet = await dynamoClient.send(new BatchGetCommand({
            RequestItems: {
                [TABLE_NAME]: {
                Keys: keys,
                ProjectionExpression: "id, content, sourceTitle, sourceURL, createdAt"
                }
            }
            }));
            
            const foundItems = batchGet.Responses?.[TABLE_NAME] || [];
            
            for (const item of foundItems) {
                contextEntries.push(`--- ENTRY (DB: ${item.createdAt}) ---\n${item.content}`);
                contextSources.push({
                    id: item.id,
                    title: item.sourceTitle || "Archived Entry",
                    url: item.sourceURL
                });
            }
        } catch (err) {
            console.error("Failed to fetch missing content from DynamoDB", err);
        }
      }

      const contextText = contextEntries.join("\n\n");

      // 4. Synthesize Answer with Gemini
      const ragModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const ragPrompt = `${RAG_SYSTEM_PROMPT}\n\nUSER QUESTION:\n${routerOutput.content}\n\nRETRIEVED CONTEXT:\n${contextText || "No relevant context found."}`;
      
      const ragResult = await ragModel.generateContent(ragPrompt);
      const answer = ragResult.response.text();

      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Query processed", 
          intent: 'query',
          answer: answer,
          contextSources 
        }),
      };
    }

    // ---------------------------------------------------------
    // BRANCH B: SAVE / LOG_READING
    // ---------------------------------------------------------
    
    // 3. ID Generation
    const id = (await KSUID.random()).string;
    const now = new Date().toISOString();

    // 4. Prepare DynamoDB Record
    // CRITICAL: For text, we use the RAW input to preserve exact wording. 
    // The Intent Router (AI) is only trusted for metadata or if it's processing audio/images.
    const finalContent = (routerOutput.mediaType === 'text' || !routerOutput.mediaType) 
        ? rawInput 
        : routerOutput.content;

    const record: ConstellationRecord = {
      PK: `USER#${userId}`,
      SK: `ENTRY#${id}`,
      id,
      type: "Entry",
      createdAt: now,
      updatedAt: now,
      content: finalContent,
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

    // --- SUB-BRANCH: LOG READING ---
    if (routerOutput.intent === 'log_reading') {
        await updateReadingList(finalContent);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Reading log updated successfully",
                intent: 'log_reading',
                id,
                routerOutput
            })
        };
    }

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