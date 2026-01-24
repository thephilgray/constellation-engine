import { Pinecone } from "@pinecone-database/pinecone";
import { Resource } from "sst";

// Set Host for Serverless
process.env.PINECONE_INDEX_HOST = Resource.PINECONE_INDEX_HOST.value;

const pinecone = new Pinecone({ apiKey: Resource.PINECONE_API_KEY.value });
const index = pinecone.Index("brain-dump");

async function run() {
  try {
    const stats = await index.describeIndexStats();
    console.log("Pinecone Index Stats:");
    console.log(JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error("Error fetching stats:", error);
  }
}

run();
