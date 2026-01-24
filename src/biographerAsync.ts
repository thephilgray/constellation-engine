import { GoogleGenerativeAI } from "@google/generative-ai";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, queryPinecone, sanitizeMarkdown } from "./utils";
import { saveRecord, getRecord, queryRecentEntries } from "./lib/dynamo";
import type { ConstellationRecord } from "./lib/schemas";
import { randomUUID } from "crypto";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const PINECONE_INDEX_NAME = "brain-dump";
const BIOGRAPHY_NAMESPACE = "biography";
// LIFE_LOG_PATH is no longer used for direct file access, but the concept remains
const DASHBOARD_PK = "DASHBOARD#life_log";
const DASHBOARD_SK = "STATE";

const initialLifeLogContent = `# 🧬 Life Log: The Current Chapter
*A living snapshot of where you are right now.*

## 📊 State of Mind
- **Mood:** Neutral
- **Focus:** Just getting started.
- **Active Themes:** Setting up the system.

## 🕯️ Recovered Memories
*(No memories logged yet.)*

## 💓 The Daily Pulse
- 
*${new Date().toISOString().split('T')[0]}:* The story begins here. The user has just initialized their Life Log, ready to capture the unfolding journey of their life.`;

interface AsyncPayload {
    content?: string;
    tag?: "JOURNAL" | "MEMORY";
    dateString?: string;
    userId?: string; // Added to receive user context
}

export async function handler(event: AsyncPayload) {
  console.log("Biographer Async Worker Started", event);
  try {
    const { content, tag = "JOURNAL", dateString } = event;
    const userId = event.userId || "default-user"; // Fallback for now

    const date = dateString ? new Date(dateString) : new Date();
    const isoDate = date.toISOString();
    const entryId = `biography-${date.getTime()}`;

    let contextEntries = "";

    // Fetch recent history for context (Last 5 Active Days)
    const recentRecords = await queryRecentEntries(userId, 50);
    const entriesByDate = new Map<string, string[]>();
    for (const record of recentRecords) {
        const dateKey = record.createdAt.split('T')[0];
        if (!entriesByDate.has(dateKey)) {
            entriesByDate.set(dateKey, []);
        }
        entriesByDate.get(dateKey)?.push(record.content);
    }
    // Get last 5 days chronologically
    const last5Dates = Array.from(entriesByDate.keys()).sort().slice(-5);
    
    let recentHistoryContext = "";
    for (const d of last5Dates) {
        const entries = entriesByDate.get(d);
        recentHistoryContext += `\n**${d}:**\n${entries?.map(e => `- ${e}`).join('\n')}`;
    }

    if (content) {
        // 1. Embed & Save to Pinecone (Vector Store)
        const vector = await getEmbedding(content);
        await upsertToPinecone(
          PINECONE_INDEX_NAME,
          entryId,
          vector,
          { text: content, tag, date: isoDate, userId },
          BIOGRAPHY_NAMESPACE
        );

        // 2. Persist to Unified Lake (DynamoDB)
        const record: ConstellationRecord = {
            PK: `USER#${userId}`,
            SK: `ENTRY#${entryId}`,
            id: entryId,
            type: "Entry",
            createdAt: isoDate,
            updatedAt: isoDate,
            content: content,
            isOriginal: true, // Biographer entries are always original thoughts
            mediaType: "text",
            tags: [tag.toLowerCase()],
            lastAccessed: isoDate,
        };
        await saveRecord(record);

        // 3. Recall Context from Pinecone
        const similarEntries = await queryPinecone(PINECONE_INDEX_NAME, vector, 5, BIOGRAPHY_NAMESPACE);
        contextEntries = similarEntries.matches
          .map(m => `- "${m.metadata?.text}" `)
          .join("\n");
    }

    // 4. Update Dashboard
    // Fetch current state from DynamoDB instead of GitHub
    let lifeLogContent = initialLifeLogContent;
    const existingDashboard = await getRecord(DASHBOARD_PK, DASHBOARD_SK);
    
    if (existingDashboard && existingDashboard.content) {
        lifeLogContent = existingDashboard.content;
    }

    const systemPrompt = content ? `
    You are The Biographer. You are rewriting the current chapter of the user's autobiography based on a new event.

    **Goal:** Update the "Life Log" to reflect the user's *current* state of mind and weave the new entry into a cohesive narrative. 
    **Do NOT just append text.** Reformulate the existing text to flow naturally with the new information.

    **Input Data:**
    - **Current Date:** ${isoDate.split('T')[0]}
    - **New Entry (${tag}):** "${content}"
    - **Recent History (Last 5 Active Days):**
    ${recentHistoryContext}
    - **Context (Similar Past Entries):** \n${contextEntries}

    **Current Dashboard State:**
    ${lifeLogContent}

    **Instructions for Updates:**

    1.  **## 📊 State of Mind:** 
        - Update **Mood** and **Focus** based on the *New Entry* and the *Recent History* (last 7 days).
        - Update **Active Themes**: Consolidate themes to reduce visual bloat. If a theme is no longer relevant, remove it. Add new themes that emerge from this entry.

    2.  **## 🕯️ Recovered Memories:**
        - ONLY update this if the New Entry is a 'MEMORY'. 
        - If it is, add a concise summary of the memory.
        - Do NOT prefix entries with "[Current]".
        - Limit the total number of memories in this list to **6-8 items max**. Prune the oldest or least relevant ones if needed.

    3.  **## 💓 The Daily Pulse:**
        - This section is a chronological log of the *Last 5 Active Days*.
        - **Source of Truth:** Use the **Recent History** provided above to build this list.
        - **Format:** "- **YYYY-MM-DD:** [Summary of all entries for this day]"
        - Ensure every date in the "Recent History" (up to the last 5) is represented.
        - Do NOT use "**Today:**". Always use the specific date.
        - Do NOT include dates that are not in the Recent History (unless they are already in the dashboard and you are just appending, but prefer to refresh the list based on the history).

    **Output:**
    - Return the **FULL** Markdown file content.
    - Do not use markdown code blocks (\`\`\`markdown).
    ` : `
    You are The Biographer. You are refining and polishing the user's "Life Log".

    **Goal:** Review the current dashboard for clarity, tone, and formatting. Ensure the narrative flows well and the "Daily Pulse" is up to date based on the recent history.

    **Recent History (Last 5 Active Days):**
    ${recentHistoryContext}

    **Current Dashboard State:**
    ${lifeLogContent}

    **Instructions:**
    1.  **Review & Polish:** Fix any typos, awkward phrasing, or formatting inconsistencies.
    2.  **Ensure Format Compliance:**
        - "The Daily Pulse" should use "- **YYYY-MM-DD:** [Summary]" format.
        - Ensure "The Daily Pulse" accurately reflects the **Recent History** dates.
        - "Recovered Memories" should NOT have "[Current]" prefixes and be limited to 6-8 items.
    3.  **Do NOT add new content** since no new entry was provided. Just refine what is there using the history as a fact-check.

    **Output:**
    - Return the **FULL** Markdown file content.
    - Do not use markdown code blocks (\`\`\`markdown).
    `;

    const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await generativeModel.generateContent(systemPrompt);
    const newLifeLogContent = sanitizeMarkdown(result.response.text());

    // 5. Update Dashboard in Unified Lake (DynamoDB)
    const dashboardRecord: ConstellationRecord = {
        PK: DASHBOARD_PK as any, // Cast to satisfy specific union type if needed
        SK: DASHBOARD_SK as any,
        id: "life_log",
        type: "Dashboard",
        createdAt: existingDashboard?.createdAt || isoDate, // Preserve original creation date
        updatedAt: isoDate,
        content: newLifeLogContent,
        isOriginal: false, // Generated content
        mediaType: "text",
        lastAccessed: isoDate,
    };

    await saveRecord(dashboardRecord);
    console.log("Biographer Async Worker Completed Successfully. Dashboard updated in DynamoDB.");

  } catch (error: any) {
    console.error("Biographer Async Worker Failed:", error);
    // Optional: Add specific error handling for DynamoDB vs. other errors
  }
}
