import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pinecone } from "@pinecone-database/pinecone";
import { Octokit } from "@octokit/rest";
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Resource } from "sst";

// Set environment for Pinecone Serverless
process.env.PINECONE_INDEX_HOST = Resource.PINECONE_INDEX_HOST.value;

// Initialize clients
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const pinecone = new Pinecone({ apiKey: Resource.PINECONE_API_KEY.value });
const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });

const GITHUB_OWNER = Resource.GITHUB_OWNER.value;
const GITHUB_REPO = Resource.GITHUB_REPO.value;
const PINECONE_INDEX_NAME = "brain-dump";
const DASHBOARD_FILE_PATH = "00_Current_Constellations.md";

type InputType = "IDEA" | "DRAFT" | "SOURCE";

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

    // 1. Receive Input
    const { content: newThought, type = "IDEA" }: { content: string; type?: InputType } = JSON.parse(event.body);

    // 2. Embed
    const embeddingModel = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const embeddingResult = await embeddingModel.embedContent(newThought);
    const vector = embeddingResult.embedding.values;

    // 3. Persist (Write)
    const timestamp = Date.now();
    const date = new Date(timestamp);
    const isoDate = date.toISOString().split('T')[0];
    const monthYear = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
    const pineconeIndex = pinecone.Index(PINECONE_INDEX_NAME);

    // Upsert to Pinecone
    await pineconeIndex.upsert([
      {
        id: `thought-${timestamp}`,
        values: vector,
        metadata: { text: newThought, type, timestamp, date: isoDate },
      },
    ]);

    // Create backup in GitHub
    let archivePath: string;
    switch (type) {
      case "DRAFT":
        archivePath = `Drafts/${monthYear}.md`;
        break;
      case "SOURCE":
        archivePath = `References/${monthYear}.md`;
        break;
      case "IDEA":
      default:
        archivePath = `_Archive/${monthYear}.md`;
        break;
    }

    let existingContent = "";
    let fileSha: string | undefined;
    try {
      const { data: file } = await octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: archivePath,
      });
      if ("content" in file) {
        existingContent = Buffer.from(file.content, "base64").toString("utf-8");
        fileSha = file.sha;
      }
    } catch (error: any) {
      if (error.status !== 404) throw error;
      // If file doesn't exist, it will be created.
    }

    const newContent = `${existingContent}\n\n---\n\n${newThought}`;

    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: archivePath,
      message: `archive: ${type} - ${isoDate}`,
      content: Buffer.from(newContent).toString("base64"),
      sha: fileSha,
    });

    // 4. Recall (Read)
    const fourteenDaysAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const recentResults = await pineconeIndex.query({
      vector,
      filter: { timestamp: { $gte: fourteenDaysAgo } },
      topK: 100,
      includeMetadata: true,
    });
    
    const relevantResults = await pineconeIndex.query({
      vector,
      topK: 10,
      includeMetadata: true,
    });

    const contextThoughts = [...recentResults.matches, ...relevantResults.matches]
      .filter((match, index, self) => 
        match.metadata?.text && self.findIndex(m => m.id === match.id) === index
      )
      .map(m => `[${m.metadata?.type || 'IDEA'}] "${m.metadata?.text}"`)
      .join("\n- ");
    
    const contextString = `Contextual thoughts:\n- ${contextThoughts}`;

    // 5. Fetch State
    let currentDashboardContent = "";
    let dashboardSha: string | undefined;
    try {
      const { data: dashboardFile } = await octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: DASHBOARD_FILE_PATH,
      });
      if ("content" in dashboardFile) {
        currentDashboardContent = Buffer.from(dashboardFile.content, "base64").toString("utf-8");
        dashboardSha = dashboardFile.sha;
      }
    } catch (error: any) {
      if (error.status !== 404) throw error;
      // If dashboard doesn't exist, it will be created.
    }

    // 6. Synthesize (The "Gardener")
    const generativeModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    const systemPrompt = `
      You are a Knowledge Gardener. Your task is to integrate a new thought into a living markdown document of thematic clusters called "Constellations". You are managing a Dashboard of the user's writing topics. You have 3 input types:
      - **IDEAS:** Raw thoughts. Cluster them freely.
      - **DRAFTS:** Actual writing. These indicate the user is ACTIVELY working on a topic. Give it higher priority.
      - **SOURCES:** External quotes/links. These are EVIDENCE. Never create a Constellation based on a source title. Only use sources to support existing themes.

      **Current Dashboard State:**
      ${currentDashboardContent}

      **New Thought:**
      "[${type}] ${newThought}"

      **Context from related thoughts:**
      ${contextString}

      **Rules:**
      - If the input is a DRAFT, find the matching Constellation and add a sub-header: ### 📝 Active Draft: [One line summary].
      - If the input is a SOURCE, find the matching Constellation and add a bullet point: * 📎 Ref: [Summary of source].
      - **The Graveyard Rule:** If a topic exists in the "## 🪦 Archived" section of the Current Dashboard, DO NOT generate a new Constellation for it. Ignore those thoughts.
      - **Stability Constraint:** Prefer appending to existing themes over creating new ones or renaming them. Only refactor if the new thought radically changes the context or bridges two previously separate ideas.
      - Maintain the exact markdown structure.
    `;

    const result = await generativeModel.generateContent(systemPrompt);
    const newDashboardContent = result.response.text();

    // 7. Update
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: DASHBOARD_FILE_PATH,
      message: `garden: Integrate new thought`,
      content: Buffer.from(newDashboardContent).toString("base64"),
      sha: dashboardSha,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Ingestion successful." }),
    };
  } catch (error: any) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
