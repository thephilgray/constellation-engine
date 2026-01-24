import { GoogleGenerativeAI } from "@google/generative-ai";
import { Resource } from "sst";
import { z } from "zod";
import type { ConstellationRecord } from "../lib/schemas";

const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

// Zod schema for the expected output structure from the AI
const StrategicQuerySchema = z.object({
  query: z.string().describe("The Google Books search query."),
  sort: z.enum(['newest', 'relevance']).describe("Sort order for the search."),
  rationale: z.string().describe("Why this query helps the user."),
});

const ArticleQueriesSchema = z.object({
  devToTag: z.string().describe("A relevant tag for Dev.to search (e.g., 'react', 'architecture')."),
  hnQuery: z.string().describe("A search query for Hacker News."),
  arxivQuery: z.string().describe("A search query for arXiv (CS/Math papers).")
});

const AnalysisResultSchema = z.object({
  bookQueries: z.array(StrategicQuerySchema).length(3),
  articleQueries: ArticleQueriesSchema
});
type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const handler = async (event: { recentEntries: ConstellationRecord[] }): Promise<AnalysisResult> => {
  if (!event.recentEntries || event.recentEntries.length === 0) {
    console.log("No recent entries provided. Returning empty analysis.");
    // Return a default or empty structure that won't break the next step
    return {
      bookQueries: [
        { query: "general programming", sort: 'relevance', rationale: "Default query due to no recent writing." },
        { query: "philosophy of science", sort: 'relevance', rationale: "Default query due to no recent writing." },
        { query: "history of technology", sort: 'relevance', rationale: "Default query due to no recent writing." },
      ],
      articleQueries: {
        devToTag: "programming",
        hnQuery: "technology",
        arxivQuery: "computer science"
      }
    };
  }

  // Format entries for the prompt, including metadata
  const entriesContext = event.recentEntries.map(entry => {
      const meta = [];
      if (entry.tags && entry.tags.length > 0) meta.push(`Tags: ${entry.tags.join(", ")}`);
      if (entry.mediaType) meta.push(`Type: ${entry.mediaType}`);
      if (entry.sourceTitle) meta.push(`Source: ${entry.sourceTitle}`);
      
      return `Entry (${meta.join(" | ")}):\n${entry.content.substring(0, 1000)}`; // Truncate content slightly to save tokens if very long
  }).join("\n\n---\n\n");

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: `Analyze the user's recent entries (notes, saved articles, thoughts). Identify the core topics and interests.
    Pay attention to the metadata (tags, media types).
    
    1. Generate 3 "Book Lenses" (Data, Counterpoint, Orthogonal).
    2. Generate "Article Queries" for Dev.to, Hacker News, and arXiv.

    Output a JSON object wrapped in markdown (e.g. \`\`\`json { "bookQueries": [...], "articleQueries": {...} } \`\`\`):
    
    Structure:
    {
      "bookQueries": [
        { "query": "...", "sort": "...", "rationale": "..." }, // Data Lens
        { "query": "...", "sort": "...", "rationale": "..." }, // Counterpoint Lens
        { "query": "...", "sort": "...", "rationale": "..." }  // Orthogonal Lens
      ],
      "articleQueries": {
        "devToTag": "...", // single word tag (no #)
        "hnQuery": "...",
        "arxivQuery": "..."
      }
    }
    
    For each book lens, provide:
    - query: The Google Books search query.
    - sort: 'newest' (if topic is tech/science/news) or 'relevance').
    - rationale: A brief explanation of why this query is a useful lens for the user's writing.`
  });

  const prompt = `Here are the user's recent entries:\n\n${entriesContext}`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    
    if (!text) {
        console.error("AI returned an empty response.");
        throw new Error("AI returned an empty response.");
    }

    // Clean the response to extract only the JSON part.
    // It should be wrapped in ```json ... ```
    const jsonStart = text.indexOf('```json');
    const jsonEnd = text.lastIndexOf('```');

    if (jsonStart === -1 || jsonEnd === -1 || jsonStart >= jsonEnd) {
        console.error("Could not find a JSON code block in the AI response. Response text:", text);
        throw new Error("Could not find a JSON code block in the AI response.");
    }
    
    // Extract the JSON string between ```json and ```
    const jsonText = text.substring(jsonStart + '```json'.length, jsonEnd).trim();
    
    let parsedJson;
    try {
        parsedJson = JSON.parse(jsonText);
    } catch (parseError) {
        console.error("Failed to parse JSON from AI response. Raw JSON text:", jsonText, "Original text:", text, "Error:", parseError);
        throw new Error("Failed to parse JSON from AI response.");
    }

    // Validate the output with Zod
    const validationResult = AnalysisResultSchema.safeParse(parsedJson);

    if (!validationResult.success) {
      console.error("AI output failed validation:", validationResult.error);
      throw new Error("AI output did not match the expected schema.");
    }

    return validationResult.data;
  } catch (error) {
    console.error("Error during strategic analysis with Gemini:", error);
    throw new Error("Failed to generate strategic analysis.");
  }
};
