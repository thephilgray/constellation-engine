import { GoogleGenerativeAI } from "@google/generative-ai";
import { Pinecone } from "@pinecone-database/pinecone";
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";

// Initialize clients
const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const pinecone = new Pinecone({ apiKey: Resource.PINECONE_API_KEY.value });
const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });

const GITHUB_OWNER = Resource.GITHUB_OWNER.value;
const GITHUB_REPO = Resource.GITHUB_REPO.value;

/**
 * Generates an embedding for the given content using the specified model.
 * @param content The content to embed.
 * @param model The model to use for embedding.
 * @returns The embedding vector.
 */
export async function getEmbedding(content: string, model = "text-embedding-004"): Promise<number[]> {
  const embeddingModel = genAI.getGenerativeModel({ model });
  const embeddingResult = await embeddingModel.embedContent(content);
  return embeddingResult.embedding.values;
}

/**
 * Upserts a vector to a Pinecone index.
 * @param indexName The name of the Pinecone index.
 * @param id The ID of the vector.
 * @param values The vector values.
 * @param metadata The metadata to associate with the vector.
 * @param namespace The namespace to upsert to.
 */
export async function upsertToPinecone(
  indexName: string,
  id: string,
  values: number[],
  metadata: Record<string, any>,
  namespace?: string
) {
  const index = pinecone.Index(indexName);
  const pineconeNamespace = namespace ? index.namespace(namespace) : index;
  await pineconeNamespace.upsert([{ id, values, metadata }]);
}

/**
 * Creates or updates a file in a GitHub repository.
 * @param path The path to the file.
 * @param content The content of the file.
 * @param message The commit message.
 */
export async function createOrUpdateFile(path: string, content: string, message: string) {
  let fileSha: string | undefined;
  try {
    const { data: file } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path,
    });
    if ("content" in file) {
      fileSha = file.sha;
    }
  } catch (error: any) {
    if (error.status !== 404) throw error;
    // If file doesn't exist, it will be created.
  }

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path,
    message,
    content: Buffer.from(content).toString("base64"),
    sha: fileSha,
  });
}

/**
 * Appends content to a file in a GitHub repository.
 * @param path The path to the file.
 * @param content The content to append.
 * @param message The commit message.
 */
export async function appendToFile(path: string, content: string, message: string) {
  const { content: existingContent, sha: fileSha } = await getFile(path);
  const newContent = existingContent ? `${existingContent}\n\n---\n\n${content}` : content;

  await octokit.repos.createOrUpdateFileContents({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPO,
    path,
    message,
    content: Buffer.from(newContent).toString("base64"),
    sha: fileSha,
  });
}


/**
 * Gets the content of a file from a GitHub repository.
 * @param path The path to the file.
 * @returns The content of the file and its SHA.
 */
export async function getFile(path: string): Promise<{ content: string; sha: string | undefined }> {
  console.log(`[getFile] Fetching: ${path}`);
  try {
    const { data: file } = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
    });
    console.log(`[getFile] Fetched successfully: ${path}`);

    // The response from octokit.request should be the same as octokit.repos.getContent
    // but we need to handle the case where file is an array (for directories)
    if (Array.isArray(file)) {
      console.log(`[getFile] Path is a directory, not a file: ${path}`);
      return { content: "", sha: undefined };
    }

    if ((file as any).content && (file as any).sha) {
      console.log(`[getFile] File has content and sha: ${path}`);
      return {
        content: Buffer.from((file as any).content, "base64").toString("utf-8"),
        sha: (file as any).sha,
      };
    }
    
    console.log(`[getFile] File has no content or sha: ${path}`);
    return { content: "", sha: undefined };
    
  } catch (error: any) {
    console.log(`[getFile] Caught error for path: ${path}`, JSON.stringify(error, null, 2));
    if (error.status === 404) {
      console.log(`[getFile] Error is 404, returning empty for: ${path}`);
      return { content: "", sha: undefined };
    }
    console.log(`[getFile] Error is not 404, rethrowing for: ${path}`);
    throw error;
  }
}

/**
 * Queries a Pinecone index.
 * @param indexName The name of the Pinecone index.
 * @param vector The vector to query with.
 * @param topK The number of results to return.
 * @param namespace The namespace to query.
 * @param filter The filter to apply to the query.
 * @returns The query results.
 */
export async function queryPinecone(
  indexName: string,
  vector: number[],
  topK: number,
  namespace?: string,
  filter?: Record<string, any>
) {
  const index = pinecone.Index(indexName);
  const pineconeNamespace = namespace ? index.namespace(namespace) : index;
  return await pineconeNamespace.query({
    vector,
    topK,
    filter,
    includeMetadata: true,
  });
}

/**
 * Sanitizes a markdown string by removing the wrapping ```markdown blocks.
 * @param markdown The markdown string to sanitize.
 * @returns The sanitized markdown string.
 */
export function sanitizeMarkdown(markdown: string): string {
  return markdown
    .replace(/^```markdown\s+/i, "")
    .replace(/^```\s+/i, "")
    .replace(/\s+```$/, "");
}
