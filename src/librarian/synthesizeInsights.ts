
import { GoogleGenAI } from "@google/genai";
import { Resource } from "sst";
import { z } from "zod";
import type { ConstellationRecord } from "../lib/schemas";

const genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value });

const BookSchema = z.object({
  id: z.string(),
  volumeInfo: z.object({
    title: z.string(),
    authors: z.array(z.string()).optional(),
    // Allow other fields from the book object to be present
  }).passthrough(),
}).passthrough();
type Book = z.infer<typeof BookSchema>;

interface ArticleItem {
  title: string;
  url: string;
  source: 'Dev.to' | 'HackerNews' | 'arXiv';
  contentPayload: string;
}

interface HandlerInput {
  // Direct input (if manually invoked or transformed)
  books?: (Book | null)[];
  articles?: ArticleItem[];
  recentEntries?: ConstellationRecord[];
  
  // Step Function State Input (Backward compatibility / Raw input structure)
  fetchContextResult?: {
    recentEntries: ConstellationRecord[];
  };
  mapResult?: {
    Payload: Book | null | string;
  }[];
}

export const handler = async (event: HandlerInput): Promise<string> => {
  console.log("Handler input:", JSON.stringify(event, null, 2));

  // Extract recentEntries
  const recentEntries = event.recentEntries || event.fetchContextResult?.recentEntries || [];

  // Extract books
  let books: (Book | null)[] = [];
  if (event.books) {
    books = event.books;
  } else if (event.mapResult) {
    books = event.mapResult.map(item => {
      if (!item.Payload) return null;
      let payload = item.Payload;
      
      if (typeof payload === 'string') {
        try {
          payload = JSON.parse(payload);
        } catch (e) {
          console.warn("Failed to parse book payload string:", payload);
          return null;
        }
      }
      
      // If the payload is the book itself, return it.
      if (payload && typeof payload === 'object' && 'id' in payload && 'volumeInfo' in payload) {
          return payload as Book;
      }
      
      console.warn("Payload does not match Book schema:", JSON.stringify(payload));
      return null;
    });
  }

  // Filter out nulls.
  const validBooks = books.filter((b): b is Book => b !== null);
  
  // Extract articles
  const articles = event.articles || [];

  if (validBooks.length === 0 && articles.length === 0) {
    console.log("No valid books or articles found to synthesize.");
    return `## No new recommendations were found in this run.`;
  }

  // Format entries for the prompt
  const entriesContext = recentEntries.map(entry => {
      const meta = [];
      if (entry.tags && entry.tags.length > 0) meta.push(`Tags: ${entry.tags.join(", ")}`);
      if (entry.mediaType) meta.push(`Type: ${entry.mediaType}`);
      if (entry.sourceTitle) meta.push(`Source: ${entry.sourceTitle}`);
      
      return `Entry (${meta.join(" | ")}):\n${entry.content}`;
  }).join("\n\n---\n\n") || "No recent entries provided.";

  const prompt = `
You are a literary and technical analyst. Review the selected books and articles. 
Synthesize the user's recent entries (notes, thoughts, saved items) against these materials.

**Key Instructions:**
1.  **Books:** Write a "Perspective Paragraph" explaining how the book challenges/expands the user's ideas.
2.  **Articles:** specific attention to the *Hacker News* comments. Use them to highlight potential flaws, controversies, or "real-world" friction points in the user's thinking.
3.  **Synthesis:** Do not just list items. Connect them back to the user's specific entries where possible.

**User's Recent Entries:**
---
${entriesContext}
---

**Selected Books:**
---
${JSON.stringify(validBooks.map(b => b.volumeInfo), null, 2)}
---

**Selected Articles:**
---
${JSON.stringify(articles, null, 2)}
---

**Output Format:**
Provide a response in Markdown. Group by source type (Books vs Articles) or by Theme, whichever makes for a stronger narrative.

## [Item Title]
[Source] | [Link](URL)

[Your Analysis/Perspective]

---
`;

  try {
    const result = await genAI.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [{ text: prompt }]
    });
    const markdownOutput = result.text || '';

    // Prepend a timestamped header to the final output
    const timestamp = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZoneName: 'short'
    });
    const finalMarkdown = `# Dialectical Librarian Recommendations for ${timestamp}\n\n${markdownOutput}`;
    
    return finalMarkdown;
  } catch (error) {
    console.error("Error synthesizing insights with Gemini:", error);
    throw new Error("Failed to synthesize insights.");
  }
};
