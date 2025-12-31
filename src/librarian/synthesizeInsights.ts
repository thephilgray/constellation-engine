
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Resource } from "sst";
import { z } from "zod";

const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);

const BookSchema = z.object({
  id: z.string(),
  volumeInfo: z.object({
    title: z.string(),
    authors: z.array(z.string()).optional(),
    // Allow other fields from the book object to be present
  }).passthrough(),
}).passthrough();
type Book = z.infer<typeof BookSchema>;

interface HandlerInput {
  // Direct input (if manually invoked or transformed)
  books?: (Book | null)[];
  recentWriting?: string;
  
  // Step Function State Input
  fetchContextResult?: {
    recentWriting: string;
  };
  mapResult?: {
    Payload: Book | null | string;
  }[];
}

export const handler = async (event: HandlerInput): Promise<string> => {
  console.log("Handler input:", JSON.stringify(event, null, 2));

  // Extract recentWriting
  const recentWriting = event.recentWriting || event.fetchContextResult?.recentWriting || "";

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

  // Filter out nulls. We trust the structural check above.
  const validBooks = books.filter((b): b is Book => b !== null);

  if (validBooks.length === 0) {
    console.log("No valid books found to synthesize.");
    // DEBUG: Return details about why it failed
    return `## No new book recommendations were found in this run.\n\nDebug Info:\nInput mapResult length: ${event.mapResult?.length}\nExtracted books length: ${books.length}\nValid books length: ${validBooks.length}`;
  }

  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

  const prompt = `
You are a literary analyst. For each of the selected books provided, write a "Perspective Paragraph." 
This paragraph must explain *specifically* how the book challenges, expands upon, or offers a new lens on the user's arguments and ideas as presented in their writing. 
Avoid generic summaries of the book. Focus on the dialectical relationship between the book and the user's text.

**User's Recent Writing:**
---
${recentWriting || "No writing was provided, so focus on the potential value of the book in general terms of intellectual growth."}
---

**Selected Books:**
---
${JSON.stringify(validBooks.map(b => b.volumeInfo), null, 2)}
---

**Output Format:**
For each book, provide a response in Markdown format, like this:

## [Book Title]
By [Authors]

[Your "Perspective Paragraph" here.]

---
`;

  try {
    const result = await model.generateContent(prompt);
    const markdownOutput = result.response.text();

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
