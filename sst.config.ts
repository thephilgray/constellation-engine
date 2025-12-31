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
    const GOOGLE_BOOKS_API_KEY = new sst.Secret("GOOGLE_BOOKS_API_KEY");

    // LIBRARIAN WORKFLOW START
    const librarianFunctions = {
      fetchContext: new sst.aws.Function("LibrarianFetchContext", {
        handler: "src/librarian/fetchContext.handler",
        link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO],
        timeout: "30 seconds",
      }),
      strategicAnalysis: new sst.aws.Function("LibrarianStrategicAnalysis", {
        handler: "src/librarian/strategicAnalysis.handler",
        link: [GEMINI_API_KEY],
        timeout: "30 seconds",
      }),
      fetchArticles: new sst.aws.Function("LibrarianFetchArticles", {
        handler: "src/librarian/fetchArticles.handler",
        timeout: "60 seconds",
      }),
      retrieveAndCurate: new sst.aws.Function("LibrarianRetrieveAndCurate", {
        handler: "src/librarian/retrieveAndCurate.handler",
        link: [GEMINI_API_KEY, GOOGLE_BOOKS_API_KEY, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO],
        timeout: "60 seconds",
      }),
      synthesizeInsights: new sst.aws.Function("LibrarianSynthesizeInsights", {
        handler: "src/librarian/synthesizeInsights.handler",
        link: [GEMINI_API_KEY],
        timeout: "60 seconds",
      }),
      persistRecs: new sst.aws.Function("LibrarianPersistRecs", {
        handler: "src/librarian/persistRecs.handler",
        link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO],
        timeout: "30 seconds",
      }),
    };

    const fetchContextState = sst.aws.StepFunctions.lambdaInvoke({
      name: "FetchContext",
      function: librarianFunctions.fetchContext,
      output: {
        "fetchContextResult": "{% $states.result.Payload %}",
      },
    });

    const strategicAnalysisState = sst.aws.StepFunctions.lambdaInvoke({
      name: "StrategicAnalysis",
      function: librarianFunctions.strategicAnalysis,
      payload: {
        "recentWriting": "{% $states.input.fetchContextResult.recentWriting %}",
      },
      output: {
        "fetchContextResult": "{% $states.input.fetchContextResult %}",
        "strategicAnalysisResult": "{% $states.result.Payload %}",
      },
    });

    const intelligentRetrievalState = sst.aws.StepFunctions.map({
      name: "IntelligentRetrieval",
      items: "{% $states.input.strategicAnalysisResult.bookQueries %}",
      processor: sst.aws.StepFunctions.lambdaInvoke({
        name: "RetrieveAndCurateTask",
        function: librarianFunctions.retrieveAndCurate,
        payload: {
          query: "{% $states.input.query %}",
          sort: "{% $states.input.sort %}",
          rationale: "{% $states.input.rationale %}"
        }
      }),
      output: {
        "fetchContextResult": "{% $states.input.fetchContextResult %}",
        "strategicAnalysisResult": "{% $states.input.strategicAnalysisResult %}",
        "mapResult": "{% $states.result %}"
      }
    });

    const fetchArticlesState = sst.aws.StepFunctions.lambdaInvoke({
        name: "FetchArticles",
        function: librarianFunctions.fetchArticles,
        payload: {
            "devToTag": "{% $states.input.strategicAnalysisResult.articleQueries.devToTag %}",
            "hnQuery": "{% $states.input.strategicAnalysisResult.articleQueries.hnQuery %}",
            "arxivQuery": "{% $states.input.strategicAnalysisResult.articleQueries.arxivQuery %}"
        },
        output: {
            "articles": "{% $states.result.Payload %}"
        } 
    });

    const parallelRetrievalState = sst.aws.StepFunctions.parallel({
        name: "ParallelRetrieval",
    })
    .branch(intelligentRetrievalState)
    .branch(fetchArticlesState);

    const synthesizeInsightsState = sst.aws.StepFunctions.lambdaInvoke({
      name: "SynthesizeInsights",
      function: librarianFunctions.synthesizeInsights,
      payload: {
        "books": "{% $states.input[0].mapResult %}",
        "articles": "{% $states.input[1].articles %}",
        "recentWriting": "{% $states.input[0].fetchContextResult.recentWriting %}"
      },
       output: {
        "insightsResult": "{% $states.result.Payload %}",
      }
    });

    const persistRecommendationsState = sst.aws.StepFunctions.lambdaInvoke({
      name: "PersistRecommendations",
      function: librarianFunctions.persistRecs,
      payload: {
        "markdownContent": "{% $states.input.insightsResult %}"
      },
    });

    const definition = fetchContextState
        .next(strategicAnalysisState)
        .next(parallelRetrievalState)
        .next(synthesizeInsightsState)
        .next(persistRecommendationsState);

    const dialecticalLibrarian = new sst.aws.StepFunctions("DialecticalLibrarian", {
      definition,
    });

    const librarianTrigger = new sst.aws.Function("LibrarianTrigger", {
      handler: "src/librarian/trigger.handler",
      url: true,
      link: [dialecticalLibrarian],
      permissions: [{
        actions: ["states:StartExecution"],
        resources: [dialecticalLibrarian.arn],
      }],
    });
    // LIBRARIAN WORKFLOW END

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
      librarianEndpoint: librarianTrigger.url,
    };
  },
});
