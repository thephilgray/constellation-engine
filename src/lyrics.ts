import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, appendToFile, getFile, createOrUpdateFile, queryPinecone, sanitizeMarkdown } from "./utils";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const PINECONE_INDEX_NAME = "brain-dump";
const SONG_SEEDS_PATH = "00_Song_Seeds.md";
const LYRICS_NAMESPACE = "lyrics";
const LYRICS_FOLDER = "Lyrics/Snippets";

const INITIAL_SONG_SEEDS_CONTENT = `# 🎵 Song Seeds
*Waiting for inspiration...*

## 🎸 Emerging Songs
(Clusters of lines that form a structure)

## 📦 Thematic Bins
(Lines grouped by vibe)

## 📥 Inbox
(Orphans)

## 🪦 Used / Archived
(Finished songs)
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
    const { content: newLyric }: { content: string } = JSON.parse(event.body);

    // 2. Embed & Save
    const vector = await getEmbedding(newLyric);

    const timestamp = Date.now();
    const date = new Date(timestamp);
    const yearMonth = date.toISOString().slice(0, 7); // YYYY-MM

    await upsertToPinecone(
      PINECONE_INDEX_NAME,
      `lyric-${timestamp}`,
      vector,
      { text: newLyric, timestamp },
      LYRICS_NAMESPACE
    );

    const lyricArchivePath = `${LYRICS_FOLDER}/${yearMonth}.md`;
    await appendToFile(lyricArchivePath, newLyric, `lyric: ${yearMonth}`);

    // 3. Recall (Context)
    const similarLyrics = await queryPinecone(PINECONE_INDEX_NAME, vector, 15, LYRICS_NAMESPACE);
    const contextLyrics = similarLyrics.matches
      .map(m => `- "${m.metadata?.text}" `)
      .join("\n");

    // 4. Synthesize (The Songwriter Persona)
    let currentSongSeeds = "";
    try {
        const file = await getFile(SONG_SEEDS_PATH);
        currentSongSeeds = file.content;
    } catch (error) {
        // If the file does not exist, initialize it.
        await createOrUpdateFile(SONG_SEEDS_PATH, INITIAL_SONG_SEEDS_CONTENT, "feat: Initialize Song Seeds");
        currentSongSeeds = INITIAL_SONG_SEEDS_CONTENT;
    }


    const systemPrompt = `You are an expert Songwriting Assistant.

NEW LINE: ${newLyric}

RELEVANT FRAGMENTS (From Database):
${contextLyrics}

CURRENT DASHBOARD:
${currentSongSeeds}

INSTRUCTIONS:
1. Analyze the NEW LINE for **Meter**, **Rhyme Scheme**, and **Imagery**.
2. Look at the RELEVANT FRAGMENTS. Do any of them combine with the NEW LINE to form a Couplet, Verse, or Chorus?
3. Update the Dashboard:
   - **Section 1: Emerging Songs:** Create or update clusters of lines that belong together. Give them working titles (e.g., 'The Coffee Ballad').
   - **Section 2: Thematic Bins:** Group remaining lines by strong imagery (e.g., 'Nature', 'Tech', 'Heartbreak').
   - **Section 3: The Inbox:** Place the new line here if it fits nowhere else.

CONSTRAINT: Do not alter the raw text of the lyrics. Only group and arrange them.
IMPORTANT: Output RAW markdown only. Do not wrap the output in markdown code blocks. Do not include any conversational text.`;

    const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await generativeModel.generateContent(systemPrompt);
    let newSongSeeds = result.response.text();

    // 🧹 SANITIZE: Remove the wrapping ```markdown blocks
    newSongSeeds = sanitizeMarkdown(newSongSeeds);

    // 5. Update
    await createOrUpdateFile(SONG_SEEDS_PATH, newSongSeeds, "chore: Update song seeds");

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Lyric logged and song seeds updated successfully." }),
    };
  } catch (error: any) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
