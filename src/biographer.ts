import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, getFile, createOrUpdateFile, queryPinecone, sanitizeMarkdown } from "./utils";
import { Octokit } from "@octokit/rest";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });

const GITHUB_OWNER = Resource.GITHUB_OWNER.value;
const GITHUB_REPO = Resource.GITHUB_REPO.value;

const PINECONE_INDEX_NAME = "brain-dump";
const BIOGRAPHY_NAMESPACE = "biography";
const LIFE_LOG_PATH = "00_Life_Log.md";

const initialLifeLogContent = `# 🧬 Life Log: The Current Chapter
*A living snapshot of where you are right now.*

## 📊 State of Mind
- **Mood:** Neutral
- **Focus:** Just getting started.
- **Active Themes:** Setting up the system.

## 🕯️ Recovered Memories
*(No memories logged yet.)*

## 💓 The Daily Pulse
- **${new Date().toISOString().split('T')[0]}:** The story begins here. The user has just initialized their Life Log, ready to capture the unfolding journey of their life.`;

async function customAppendToFile(path: string, content: string, message: string) {
  let existingContent = "";
  let fileSha: string | undefined;
  try {
    const { data: file } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
    });
    if ("content" in file) {
      existingContent = Buffer.from(file.content, "base64").toString("utf-8");
      fileSha = file.sha;
    }
  } catch (error: any) {
    if (error.status !== 404) throw error;
    // If file doesn't exist, it will be created.
  }

  const newContent = `${existingContent}\n\n${content}`;

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path: path,
    message: message,
    content: Buffer.from(newContent).toString("base64"),
    sha: fileSha,
  });
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    // Authentication: Support both API Key (legacy/server) and Cognito JWT (client)
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    const expectedApiKey = `Bearer ${Resource.INGEST_API_KEY.value}`;
    const isApiKeyValid = authHeader === expectedApiKey;
    const isCognitoValid = !!event.requestContext.authorizer?.jwt;

    if (!isApiKeyValid && !isCognitoValid) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    if (!event.body) {
      return { statusCode: 400, body: JSON.stringify({ message: "Request body is empty." }) };
    }

    // 1. Ingest and Validate Input
    const { content, tag = "JOURNAL", date: dateString }: { content: string; tag: "JOURNAL" | "MEMORY"; date?: string } = JSON.parse(event.body);

    // Allow empty content for "Regenerate Dashboard" mode
    // if (!content) { ... } // REMOVED check

    const date = dateString ? new Date(dateString) : new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const isoDate = `${year}-${month}-${day}`;

    let contextEntries = "";

    if (content) {
        // 2. Embed & Save to Pinecone
        const vector = await getEmbedding(content);
        await upsertToPinecone(
          PINECONE_INDEX_NAME,
          `biography-${date.getTime()}`,
          vector,
          { text: content, tag, date: isoDate },
          BIOGRAPHY_NAMESPACE
        );

        // 3. Storage Logic (GitHub)
        if (tag === 'JOURNAL') {
          const journalPath = `Journal/${year}/${month}/${isoDate}.md`;
          const photosLink = `\n\n[📸 Photos from this day](https://photos.google.com/search/${isoDate})`;
          const contentWithLink = `${content}${photosLink}`;
          await customAppendToFile(journalPath, contentWithLink, `journal: ${isoDate}`);
        } else if (tag === 'MEMORY') {
          const memoryPath = `Memories/Log/${year}-${month}.md`;
          const header = `### [Recalled on ${isoDate}]`;
          const contentWithHeader = `${header}\n${content}`;
          await customAppendToFile(memoryPath, contentWithHeader, `memory: ${isoDate}`);
        }

        // 4. The "Biographer" Logic (Gemini 2.0 Flash)
        // Step A: Recall
        const similarEntries = await queryPinecone(PINECONE_INDEX_NAME, vector, 5, BIOGRAPHY_NAMESPACE);
        contextEntries = similarEntries.matches
          .map(m => `- "${m.metadata?.text}" `)
          .join("\n");
    }

    // Step B: System Prompt Construction
    let { content: lifeLogContent } = await getFile(LIFE_LOG_PATH);
    if (!lifeLogContent) {
        lifeLogContent = initialLifeLogContent;
    }

    const systemPrompt = content ? `
    You are The Biographer. You are rewriting the current chapter of the user's autobiography based on a new event.

    **Goal:** Update the "Life Log" to reflect the user's *current* state of mind and weave the new entry into a cohesive narrative. 
    **Do NOT just append text.** Reformulate the existing text to flow naturally with the new information.

    **Input Data:**
    - **Current Date:** ${isoDate}
    - **New Entry (${tag}):** "${content}"
    - **Context (Similar Past Entries):** \n${contextEntries}

    **Current Dashboard State:**
    ${lifeLogContent}

    **Instructions for Updates:**

    1.  **## 📊 State of Mind:** 
        - Update **Mood** and **Focus** to match the *new entry*.
        - Update **Active Themes**: If a theme from the past is no longer relevant, remove it. Add new themes that emerge from this entry.

    2.  **## 🕯️ Recovered Memories:**
        - ONLY update this if the New Entry is a 'MEMORY'. 
        - If it is, add a concise summary of the memory.
        - Do NOT prefix entries with "[Current]".
        - If not, keep the existing memories (unless they are very old/stale, then you can prune them).

    3.  **## 💓 The Daily Pulse:**
        - This section is a chronological log of summaries.
        - Add a new bullet point for the **Current Date** (${isoDate}) summarizing the New Entry.
        - **Format:** "- **YYYY-MM-DD:** [Summary]"
        - Do NOT use "**Today:**". Always use the specific date.
        - Keep previous entries. If the list gets too long (over 10 entries), summarize the oldest ones into a single paragraph at the top of this section or remove them if they are captured in the "Story Bible".

    **Output:**
    - Return the **FULL** Markdown file content.
    - Do not use markdown code blocks (\`\`\`markdown).
    ` : `
    You are The Biographer. You are refining and polishing the user's "Life Log".

    **Goal:** Review the current dashboard for clarity, tone, and formatting. Ensure the narrative flows well and the "Daily Pulse" is up to date (without adding new information).

    **Current Dashboard State:**
    ${lifeLogContent}

    **Instructions:**
    1.  **Review & Polish:** Fix any typos, awkward phrasing, or formatting inconsistencies.
    2.  **Ensure Format Compliance:**
        - "The Daily Pulse" should use "- **YYYY-MM-DD:** [Summary]" format.
        - "Recovered Memories" should NOT have "[Current]" prefixes.
    3.  **Do NOT add new content** since no new entry was provided. Just refine what is there.

    **Output:**
    - Return the **FULL** Markdown file content.
    - Do not use markdown code blocks (\`\`\`markdown).
    `;

    const generativeModel = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
    const result = await generativeModel.generateContent(systemPrompt);
    const newLifeLogContent = sanitizeMarkdown(result.response.text());

    // 5. Update Dashboard
    await createOrUpdateFile(LIFE_LOG_PATH, newLifeLogContent, "chore: Update Life Log dashboard");

    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: "Biography entry processed and Life Log updated successfully.",
        analysis: newLifeLogContent
      }),
    };
  } catch (error: any) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
