import { GoogleGenerativeAI } from "@google/generative-ai";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { ConstellationRecord } from "../lib/schemas";

const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const dynamoClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE_NAME = Resource.UnifiedLake.name;
const DASHBOARD_PK = "DASHBOARD#reading_list";
const DASHBOARD_SK = "STATE";

// We reuse the initial content if needed, though we expect it to exist
const INITIAL_READING_LIST = `# 📚 The Reading List
*Curated wisdom for your journey.*

## 🌟 Top Recommendations
*(No recommendations generated yet. Run the /read command to generate.)*

## 📖 Current Reading
- **Title:** [Placeholder]
- **Author:** [Placeholder]

## 🗃️ Archive
*(Empty)*`;

function sanitizeMarkdown(text: string): string {
    return text.replace(/```markdown\n?/g, "").replace(/```/g, "").trim();
}

export async function updateReadingList(newLog: string) {
    console.log("Updating Reading List Dashboard with:", newLog);

    try {
        // 1. Fetch Current Dashboard
        let currentContent = INITIAL_READING_LIST;
        let createdAt = new Date().toISOString();

        const getCmd = new GetCommand({
            TableName: TABLE_NAME,
            Key: { PK: DASHBOARD_PK, SK: DASHBOARD_SK }
        });
        const { Item } = await dynamoClient.send(getCmd);
        
        if (Item && Item.content) {
            currentContent = Item.content;
            createdAt = Item.createdAt;
        }

        // 2. Generate Update via Gemini
        const systemPrompt = `
        You are the Librarian of the Constellation Engine. 
        You manage the user's "Reading List" dashboard.
        
        **Goal:** Update the dashboard based on the user's latest log entry.

        **New Log Entry:** "${newLog}"

        **Current Dashboard:**
        ${currentContent}

        **Instructions:**
        1.  **## 📖 Current Reading:**
            - If the user says they *started* reading a book, ADD it here.
            - Format: "- **Title:** [Title] by [Author]" (Extract author if possible, or leave blank).
            - If the user explicitly says they *stopped* or *finished* a book that is listed here, REMOVE it from this section.
        
        2.  **## 🗃️ Archive:**
            - If the user says they *finished* a book, ADD it here.
            - Format: "- **[YYYY-MM-DD]** Finished: *[Title]* by [Author]" (Use today's date: ${new Date().toISOString().split('T')[0]}).
            - Keep the list chronological (newest at top).

        3.  **## 🌟 Top Recommendations:**
            - Leave this section UNTOUCHED unless the user explicitly rejects a recommendation mentioned here (e.g., "I tried [Book] from the recs and hated it"). In that case, remove it.

        **Output:**
        - Return the **FULL** Markdown file content.
        - Do not use markdown code blocks.
        `;

        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const result = await model.generateContent(systemPrompt);
        const newContent = sanitizeMarkdown(result.response.text());

        // 3. Save to DynamoDB
        const isoDate = new Date().toISOString();
        const record: ConstellationRecord = {
            PK: DASHBOARD_PK as any,
            SK: DASHBOARD_SK as any,
            id: "reading_list",
            type: "Dashboard",
            createdAt: createdAt,
            updatedAt: isoDate,
            content: newContent,
            isOriginal: false,
            mediaType: "text",
            lastAccessed: isoDate,
            // We allow backup (default) so the file on GitHub updates
        };

        await dynamoClient.send(new PutCommand({
            TableName: TABLE_NAME,
            Item: record
        }));

        console.log("Successfully updated Reading List Dashboard.");
        return newContent;

    } catch (error) {
        console.error("Error updating reading list:", error);
        throw error;
    }
}
