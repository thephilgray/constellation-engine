import { GoogleGenerativeAI } from "@google/generative-ai";
import { Resource } from "sst";
import axios from "axios";
import { z } from "zod";
import { Octokit } from "@octokit/rest";

const genAI = new GoogleGenerativeAI(Resource.GEMINI_API_KEY.value);
const googleBooksApiKey = Resource.GOOGLE_BOOKS_API_KEY.value;

const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
const owner = Resource.GITHUB_OWNER.value;
const repo = Resource.GITHUB_REPO.value;
const recommendationsFile = "BookRecommendations.md";


// Define the structure of a book item from Google Books API for type safety
const BookSchema = z.object({
  id: z.string(),
  volumeInfo: z.object({
    title: z.string(),
    authors: z.array(z.string()).optional(),
    publisher: z.string().optional(),
    publishedDate: z.string().optional(),
    description: z.string().optional(),
    industryIdentifiers: z.array(z.object({
      type: z.string(),
      identifier: z.string(),
    })).optional(),
    pageCount: z.number().optional(),
    categories: z.array(z.string()).optional(),
    averageRating: z.number().optional(),
    ratingsCount: z.number().optional(),
    imageLinks: z.object({
      thumbnail: z.string().optional(),
    }).optional(),
    infoLink: z.string().optional(),
  }),
});
type Book = z.infer<typeof BookSchema>;

interface HandlerInput {
    query: string;
    sort: 'newest' | 'relevance';
    rationale: string;
}

async function getPastRecommendations(): Promise<string[]> {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: recommendationsFile,
        });

        if (!('content' in data)) {
            return [];
        }

        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        // Simple regex to find markdown headings (e.g., "## Book Title")
        const titles = content.match(/^##\s*(.*)/gm);
        return titles ? titles.map(title => title.replace("## ", "").trim()) : [];

    } catch (error: any) {
        if (error.status === 404) {
            console.log(`${recommendationsFile} not found. Assuming no past recommendations.`);
            return [];
        }
        console.error("Error fetching past recommendations:", error);
        return [];
    }
}

export const handler = async (event: HandlerInput): Promise<Book | null> => {
  console.log("Handler input:", JSON.stringify(event, null, 2));
  const { query, sort, rationale } = event;
  const pastRecsList = await getPastRecommendations();

  // 1. Search: Call Google Books API
  const searchUrl = new URL("https://www.googleapis.com/books/v1/volumes");
  searchUrl.searchParams.append("q", query);
  searchUrl.searchParams.append("key", googleBooksApiKey);
  searchUrl.searchParams.append("maxResults", "20");
  searchUrl.searchParams.append("orderBy", sort);

  let books: Book[] = [];
  try {
    console.log("Fetching books from:", searchUrl.toString());
    const response = await axios.get(searchUrl.toString());
    const items = response.data.items || [];
    const parseResult = z.array(BookSchema).safeParse(items);
    if (parseResult.success) {
      books = parseResult.data;
    } else {
        console.warn("Could not parse some books from Google API:", parseResult.error);
        // We can still proceed with the books that were successfully parsed
        books = items.map((item: any) => BookSchema.safeParse(item)).filter((res: any) => res.success).map((res: any) => res.data);
    }
  } catch (error) {
    console.error("Error fetching from Google Books API for query:", query, error);
    throw new Error("Failed to search for books.");
  }

  if (books.length === 0) {
    console.log("No books found for query:", query);
    return null;
  }

  // 2. Curate & Dedupe: Call Gemini
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
  const prompt = `You are a curator. Review this list of 20 books. Your task is to select the single best book that fits the provided rationale.

**Rationale:** ${rationale}

**Rules:**
1.  **Exclude past recommendations:** Do NOT select any book whose title appears in this list: ${JSON.stringify(pastRecsList)}.
2.  **Prioritize Quality:** Prefer authoritative, highly-rated works.
3.  **Penalize Age (for Tech):** If the topic is technical, heavily penalize outdated books (e.g., a 2015 book on a fast-moving programming topic is bad).
4.  **Return ONLY the original JSON object of the winning book.** Do not add any commentary or surrounding text.

**Book List:**
${JSON.stringify(books, null, 2)}
`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const jsonText = text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const selectedBookJson = JSON.parse(jsonText);

    // Validate that the selected book is one of the ones we sent
    const finalBook = BookSchema.parse(selectedBookJson);
    if (!books.some(b => b.id === finalBook.id)) {
        throw new Error("AI returned a book that was not in the original list.");
    }
    
    return finalBook;
  } catch (error) {
    console.error("Error during curation with Gemini:", error);
    // As a fallback, return the first book that isn't a past recommendation
    const fallbackBook = books.find(book => !pastRecsList.includes(book.volumeInfo.title));
    return fallbackBook || null;
  }
};