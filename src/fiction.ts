import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, appendToFile, getFile, createOrUpdateFile, queryPinecone, sanitizeMarkdown } from "./utils";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const PINECONE_INDEX_NAME = "brain-dump";
const STORY_BIBLE_PATH = "00_Story_Bible.md";
const FICTION_NAMESPACE = "fiction";
const FICTION_FOLDER = "Fiction";

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
    const { content, tag = "IDEA" }: { content: string, tag: "IDEA" | "SCENE" | "CHARACTER" } = JSON.parse(event.body);

    // 2. Embed & Save to Vector DB
    const vector = await getEmbedding(content);
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const isoDate = date.toISOString().split('T')[0];

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      `fiction-${timestamp}`,
      vector,
      { text: content, tag, timestamp, date: isoDate },
      FICTION_NAMESPACE
    );

    // 3. Conditional File System Storage
    const month = date.toISOString().slice(0, 7); // YYYY-MM
    let archivePath: string;

    if (tag === 'SCENE') {
      archivePath = `${FICTION_FOLDER}/Scenes/${month}.md`;
      const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      const sceneHeader = `## [${time}] Scene Draft`;
      await appendToFile(archivePath, `${sceneHeader}\n${content}`, `feat: Draft new scene for ${month}`);
    } else { // IDEA or CHARACTER
      archivePath = `${FICTION_FOLDER}/Ideas/${month}.md`;
      await appendToFile(archivePath, content, `feat: Add new fiction idea for ${month}`);
    }

    // 4. "Lore Keeper" Logic
    // Step A: Recall
    const similarItems = await queryPinecone(PINECONE_INDEX_NAME, vector, 10, FICTION_NAMESPACE);
    const context = similarItems.matches
      .map(m => `- "${m.metadata?.text}" (Tag: ${m.metadata?.tag})`)
      .join("\n");

    let storyBibleContent: string;
    try {
      const bibleFile = await getFile(STORY_BIBLE_PATH);
      storyBibleContent = bibleFile.content;
    } catch (error: any) {
      if (error.status === 404) {
        console.log("Story Bible not found, creating a new one.");
        storyBibleContent = STORY_BIBLE_TEMPLATE;
      } else {
        throw error;
      }
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

    // 5. Update Story Bible
    await createOrUpdateFile(STORY_BIBLE_PATH, newBibleContent, "chore: Update story bible");

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Fiction entry processed successfully." }),
    };
  } catch (error: any) {
    console.error("Error in fiction handler:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
