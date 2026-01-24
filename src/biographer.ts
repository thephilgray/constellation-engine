import { GoogleGenerativeAI } from "@google/generative-ai";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getEmbedding, upsertToPinecone, getFile, createOrUpdateFile, queryPinecone } from "./utils";
import { Octokit } from "@octokit/rest";

// Initialize Gemini client
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });

const GITHUB_OWNER = Resource.GITHUB_OWNER.value;
const GITHUB_REPO = Resource.GITHUB_REPO.value;

const PINECONE_INDEX_NAME = "brain-dump";
const BIOGRAPHY_NAMESPACE = "biography";
const LIFE_LOG_PATH = "00_Life_Log.md";

const initialLifeLogContent = `# 🧬 Life Log
*The running history of past and present.*

## 📅 The Daily Pulse
(Last 7 days of journal summaries)

## 📉 Current Mood / Headspace
(What is occupying your mind *right now*)

## 🕰️ Recovered Memories
(Recently logged memories from the past)

## 🏆 Life Milestones & Eras
(Timeline of major events)

## 🧵 Recurring Themes
(Patterns across your life)`;

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

    if (!content) {
      return { statusCode: 400, body: JSON.stringify({ message: "Content is required." }) };
    }

    const date = dateString ? new Date(dateString) : new Date();
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const isoDate = `${year}-${month}-${day}`;

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

    // 4. The "Biographer" Logic (Gemini 2.5 Flash)
    // Step A: Recall
    const similarEntries = await queryPinecone(PINECONE_INDEX_NAME, vector, 5, BIOGRAPHY_NAMESPACE);
    const contextEntries = similarEntries.matches
      .map(m => `- "${m.metadata?.text}" `)
      .join("\n");

    // Step B: System Prompt Construction
    let { content: lifeLogContent } = await getFile(LIFE_LOG_PATH);
    if (!lifeLogContent) {
        lifeLogContent = initialLifeLogContent;
    }

    let systemPrompt: string;
    switch (tag) {
      case 'JOURNAL':
        systemPrompt = `You are a Daily Reflector.
1. **Reflect:** Briefly identify the mood and key events of this entry.
2. **Update Dashboard:**
   - Update 
## 📅 The Daily Pulse
: Add a 1-line summary of today's vibe.
   - Update 
## 📉 Current Mood
: Adjust the sentiment tracker based on this entry.

**Current Life Log:**
${lifeLogContent}

**New Journal Entry:**
"${content}"

**Context from similar entries:**
${contextEntries}

**Instructions:**
- Integrate the new entry's themes into the existing Life Log.
- Update the "The Daily Pulse" and "Current Mood / Headspace" sections.
- Keep the analysis concise.
- Maintain the markdown structure.
- CRITICAL: The output must be RAW MARKDOWN ONLY. Do not wrap the output in \`\`\`markdown \`\`\` code blocks.`;
        break;
      case 'MEMORY':
        systemPrompt = `You are a Family Archivist.
1. **Analyze:** Identify the people, the era (childhood, college, etc.), and the lesson.
2. **Update Dashboard:**
   - Add to 
## 🕰️ Recovered Memories
: 
[Era] - [Summary]
.
   - Update 
## 🏆 Life Milestones
 if this is a significant event.
   - Update 
## 🧵 Recurring Themes
 if this connects to other entries in the Context."

**Current Life Log:**
${lifeLogContent}

**New Memory:**
"${content}"

**Context from similar entries:**
${contextEntries}

**Instructions:**
- Integrate the new memory's themes and symbols into the existing Life Log.
- Update the "Recovered Memories", "Life Milestones & Eras", and "Recurring Themes" sections.
- Keep the analysis concise and focused on symbolic meaning.
- Maintain the markdown structure.
- CRITICAL: The output must be RAW MARKDOWN ONLY. Do not wrap the output in \`\`\`markdown \`\`\` code blocks.`;
        break;
    }

    const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const result = await generativeModel.generateContent(systemPrompt);
    const newLifeLogContent = result.response.text();

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
