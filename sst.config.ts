/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "constellation-engine",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
    };
  },
  async run() {
    const GEMINI_API_KEY = new sst.Secret("GEMINI_API_KEY");
    const PINECONE_API_KEY = new sst.Secret("PINECONE_API_KEY");
    const PINECONE_INDEX_HOST = new sst.Secret("PINECONE_INDEX_HOST");
    const GITHUB_TOKEN = new sst.Secret("GITHUB_TOKEN");
    const GITHUB_OWNER = new sst.Secret("GITHUB_OWNER");
    const GITHUB_REPO = new sst.Secret("GITHUB_REPO");
    const INGEST_API_KEY = new sst.Secret("INGEST_API_KEY");

    // Define the Function with a Public URL
    const ingest = new sst.aws.Function("Ingest", {
      handler: "src/ingest.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY],
    });

    const dream = new sst.aws.Function("DreamFunction", {
      handler: "src/dreams.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY],
    });

    const lyrics = new sst.aws.Function("LyricsFunction", {
      handler: "src/lyrics.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY],
    });

    const fiction = new sst.aws.Function("FictionFunction", {
      handler: "src/fiction.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY],
    });

    const biographer = new sst.aws.Function("BiographerFunction", {
      handler: "src/biographer.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY],
    });

    return {
      api: ingest.url,
      dreamsEndpoint: dream.url,
      lyricsEndpoint: lyrics.url,
      fictionEndpoint: fiction.url,
      biographerEndpoint: biographer.url,
    };
  },
});
