import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, appendToFile, getFile, createOrUpdateFile, queryPinecone, sanitizeMarkdown } from "./utils";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const PINECONE_INDEX_NAME = "brain-dump";
const DREAM_JOURNAL_ANALYSIS_PATH = "00_Dream_Journal_Analysis.md";
const DREAMS_NAMESPACE = "dreams";
const DREAMS_FOLDER = "Dreams";

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

    // 1. Ingest
    const { content: newDream }: { content: string } = JSON.parse(event.body);

    // 2. Embed & Save
    const vector = await getEmbedding(newDream);

    const timestamp = Date.now();
    const date = new Date(timestamp);
    const isoDate = date.toISOString().split('T')[0];

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      `dream-${timestamp}`,
      vector,
      { text: newDream, timestamp, date: isoDate },
      DREAMS_NAMESPACE
    );

    const dreamArchivePath = `${DREAMS_FOLDER}/${isoDate}.md`;
    await appendToFile(dreamArchivePath, newDream, `dream: ${isoDate}`);

    // 3. Recall (Context)
    const similarDreams = await queryPinecone(PINECONE_INDEX_NAME, vector, 5, DREAMS_NAMESPACE);
    const contextDreams = similarDreams.matches
      .map(m => `- "${m.metadata?.text}" `)
      .join("\n");

    // 4. Synthesize (Gemini 2.5 Flash)
    const { content: currentAnalysis } = await getFile(DREAM_JOURNAL_ANALYSIS_PATH);

    const systemPrompt = `
      You are a Jungian Analyst. Your task is to interpret a new dream in the context of recent, similar dreams and update a running analysis document. Focus on identifying recurring symbols (e.g., water, falling, animals, specific people), emotional themes, and potential narrative threads.

      **Current Dream Journal Analysis:**
      ${currentAnalysis}

      **New Dream:**
      "${newDream}"

      **Context from similar dreams:**
      ${contextDreams}

      **Instructions:**
      - Integrate the new dream's themes and symbols into the existing analysis.
      - Update the "Recurring Symbols" and "Emotional Landscape" sections.
      - If a new major theme emerges, add a new section for it.
      - Keep the analysis concise and focused on symbolic meaning.
      - Maintain the markdown structure.
      - Output RAW markdown only. Do not wrap the output in markdown code blocks.
    `;

    const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await generativeModel.generateContent(systemPrompt);
    let newAnalysis = result.response.text();

    // 🧹 SANITIZE: Remove the wrapping ```markdown blocks
    newAnalysis = sanitizeMarkdown(newAnalysis);

    // 5. Update
    await createOrUpdateFile(DREAM_JOURNAL_ANALYSIS_PATH, newAnalysis, "chore: Update dream journal analysis");

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Dream logged and analyzed successfully." }),
    };
  } catch (error: any) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
