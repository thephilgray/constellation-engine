import { GoogleGenerativeAI } from "@google/generative-ai";
import { Resource } from "sst";
import { z } from "zod";

const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

// Zod schema for the expected output structure from the AI
const StrategicQuerySchema = z.object({
  query: z.string().describe("The Google Books search query."),
  sort: z.enum(['newest', 'relevance']).describe("Sort order for the search."),
  rationale: z.string().describe("Why this query helps the user."),
});

const AnalysisResultSchema = z.array(StrategicQuerySchema).length(3);
type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const handler = async (event: { recentWriting: string }): Promise<AnalysisResult> => {
  if (!event.recentWriting) {
    console.log("No recent writing provided. Returning empty analysis.");
    // Return a default or empty structure that won't break the next step
    return [
        { query: "general programming", sort: 'relevance', rationale: "Default query due to no recent writing." },
        { query: "philosophy of science", sort: 'relevance', rationale: "Default query due to no recent writing." },
        { query: "history of technology", sort: 'relevance', rationale: "Default query due to no recent writing." },
    ];
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    systemInstruction: `Analyze the user's writing. Identify the core topics. If the topic is technical, scientific, or news-related, prioritize recency. Generate exactly 3 objects, one for each Lens, as a JSON array. Wrap the JSON array in a markdown code block (e.g., \`\`\`json[{"query": "...", "sort": "...", "rationale": "..."}, ...]\`\`\`):
    1.  Data Lens (Empirical evidence, foundational texts).
    2.  Counterpoint Lens (Opposing arguments, alternative schools of thought).
    3.  Orthogonal Lens (Metaphorical concepts, related ideas from different fields).

    For each lens, provide:
    - query: The Google Books search query.
    - sort: 'newest' (if topic is tech/science/news) or 'relevance').
    - rationale: A brief explanation of why this query is a useful lens for the user's writing.`
  });

  const prompt = `Here is the user's recent writing:\n\n---\n\n${event.recentWriting}\n\n---`;

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
