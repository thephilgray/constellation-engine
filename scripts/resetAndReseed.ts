import { Pinecone } from "@pinecone-database/pinecone";
import { Resource } from "sst";
import { runLazarusMigration } from "./migrateLegacy";

const PINECONE_API_KEY = Resource.PINECONE_API_KEY.value;
const PINECONE_INDEX_HOST = Resource.PINECONE_INDEX_HOST.value;
const PINECONE_INDEX_NAME = "brain-dump";

// Set Host for Serverless
process.env.PINECONE_INDEX_HOST = PINECONE_INDEX_HOST;

const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = pinecone.Index(PINECONE_INDEX_NAME);

// List of namespaces to clear
const NAMESPACES = ["biography", "dreams", "lyrics", "fiction", "ideas"];

async function resetAndReseed() {
  console.log("Starting Reset & Reseed process...");
  console.log(`Target Index: ${PINECONE_INDEX_NAME}`);
  console.log(`Target Namespaces: ${NAMESPACES.join(", ")}`);

  // 1. Clear Namespaces
  console.log("\n--- STEP 1: Clearing Vectors ---");
  for (const ns of NAMESPACES) {
    try {
      console.log(`Clearing namespace: ${ns}...`);
      const pineconeNamespace = index.namespace(ns);
      await pineconeNamespace.deleteAll();
      console.log(`  -> Successfully cleared ${ns}`);
    } catch (error) {
      console.warn(`  -> Warning: Failed to clear namespace ${ns}. It might be empty or invalid.`, error);
    }
  }

  // 2. Reseed
  console.log("\n--- STEP 2: Reseeding Index ---");
  try {
    await runLazarusMigration();
    console.log("  -> Reseeding complete.");
  } catch (error) {
    console.error("  -> FAILED to reseed:", error);
  }

  console.log("\nReset & Reseed process finished.");
}

// Execute if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  resetAndReseed();
}
