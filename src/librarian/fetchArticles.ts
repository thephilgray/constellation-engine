import axios from "axios";
import { XMLParser } from "fast-xml-parser";

interface ArticleItem {
  title: string;
  url: string;
  source: 'Dev.to' | 'HackerNews' | 'arXiv';
  contentPayload: string;
}

interface ArticleQueries {
  devToTag: string;
  hnQuery: string;
  arxivQuery: string;
}

export const handler = async (event: ArticleQueries): Promise<ArticleItem[]> => {
  console.log("Fetching articles with queries:", JSON.stringify(event, null, 2));

  const results = await Promise.allSettled([
    fetchDevTo(event.devToTag),
    fetchHackerNews(event.hnQuery),
    fetchArxiv(event.arxivQuery)
  ]);

  const articles: ArticleItem[] = [];

  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      articles.push(...result.value);
    } else {
      console.error(`Error fetching from source ${index}:`, result.reason);
    }
  });

  return articles;
};

async function fetchDevTo(tag: string): Promise<ArticleItem[]> {
  try {
    const url = `https://dev.to/api/articles`;
    const response = await axios.get(url, {
        params: {
            tag: tag,
            per_page: 3,
            top: 7 // Top articles of the week
        }
    });
    
    return response.data.map((item: any) => ({
      title: item.title,
      url: item.url,
      source: 'Dev.to',
      contentPayload: item.description || "No description available."
    }));
  } catch (error) {
    console.error("Dev.to fetch failed:", error);
    return [];
  }
}

async function fetchHackerNews(query: string): Promise<ArticleItem[]> {
  try {
    // 1. Search for recent stories with significant discussion
    const searchUrl = `http://hn.algolia.com/api/v1/search_by_date`;
    const searchResponse = await axios.get(searchUrl, {
        params: {
            tags: 'story',
            query: query,
            numericFilters: 'num_comments>10', // Ensure there is actual discourse
            hitsPerPage: 1
        }
    });

    if (!searchResponse.data.hits || searchResponse.data.hits.length === 0) {
        return [];
    }

    const topStory = searchResponse.data.hits[0];
    const storyId = topStory.objectID;

    // 2. Fetch item details for comments
    const itemUrl = `http://hn.algolia.com/api/v1/items/${storyId}`;
    const itemResponse = await axios.get(itemUrl);
    const storyData = itemResponse.data;

    // Extract top 3 comments
    const comments: string[] = [];
    if (storyData.children) {
        const topComments = storyData.children.slice(0, 3);
        topComments.forEach((comment: any) => {
            if (comment.text) {
                 // Simple HTML strip (optional, but good for LLM)
                const text = comment.text.replace(/<[^>]*>?/gm, '');
                comments.push(`- ${comment.author}: ${text}`);
            }
        });
    }

    const contentPayload = comments.length > 0 
        ? `Top Comments:\n${comments.join('\n')}` 
        : "No comments found.";

    return [{
        title: topStory.title,
        url: `https://news.ycombinator.com/item?id=${storyId}`,
        source: 'HackerNews',
        contentPayload: contentPayload
    }];

  } catch (error) {
    console.error("Hacker News fetch failed:", error);
    return [];
  }
}

async function fetchArxiv(query: string): Promise<ArticleItem[]> {
  try {
    const url = `http://export.arxiv.org/api/query`;
    const response = await axios.get(url, {
        params: {
            search_query: `all:${query}`,
            sortBy: 'submittedDate',
            sortOrder: 'descending',
            start: 0,
            max_results: 3
        }
    });

    const parser = new XMLParser();
    const result = parser.parse(response.data);
    
    const entries = result.feed?.entry;
    
    if (!entries) return [];
    
    // entries can be a single object or an array
    const entriesArray = Array.isArray(entries) ? entries : [entries];

    return entriesArray.map((entry: any) => ({
        title: entry.title,
        url: entry.id, // arXiv ID is usually the URL
        source: 'arXiv',
        contentPayload: entry.summary ? entry.summary.trim().replace(/\s+/g, ' ') : "No summary."
    }));

  } catch (error) {
    console.error("arXiv fetch failed:", error);
    return [];
  }
}
