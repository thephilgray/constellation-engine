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

    // NEW: Authentication (with Google Identity Provider)
    // Note: 'identityProviders' is not a direct property of CognitoUserPool args in this version.
    // You must add identity providers (like Google) using sst.aws.CognitoIdentityProvider or via the Console.
    // Below we configure the User Pool and the Client.
    const auth = new sst.aws.CognitoUserPool("Auth", {
        transform: {
            userPool: {
                // You can customize the CloudFormation/Pulumi resource here if needed
                // e.g. mfaConfiguration: "OFF"
                adminCreateUserConfig: {
                    allowAdminCreateUserOnly: true,
                },
            }
        }
    });

    // NEW: Multimedia Storage
    const bucket = new sst.aws.Bucket("AssetBucket");

    // NEW: The Unified Lake Table
    const table = new sst.aws.Dynamo("UnifiedLake", {
      fields: { PK: "string", SK: "string" },
      primaryIndex: { hashKey: "PK", rangeKey: "SK" },
      stream: "new-image",
    });

    // NEW: Async GitHub Backup Worker
    // Fix: 'table.subscribe' expects a handler function definition (object or string), not a Resource object.
    table.subscribe({
        handler: "src/workers/githubBackup.handler",
        link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GEMINI_API_KEY, PINECONE_API_KEY],
    }, {
      filters: [{ dynamodb: { NewImage: { type: { S: ["Entry"] } } } }]
    });

    // LIBRARIAN WORKFLOW START
    const librarianFunctions = {
      fetchContext: new sst.aws.Function("LibrarianFetchContext", {
        handler: "src/librarian/fetchContext.handler",
        link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, table],
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
        link: [GEMINI_API_KEY, GOOGLE_BOOKS_API_KEY, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, table],
        timeout: "60 seconds",
      }),
      synthesizeInsights: new sst.aws.Function("LibrarianSynthesizeInsights", {
        handler: "src/librarian/synthesizeInsights.handler",
        link: [GEMINI_API_KEY],
        timeout: "60 seconds",
      }),
      persistRecs: new sst.aws.Function("LibrarianPersistRecs", {
        handler: "src/librarian/persistRecs.handler",
        link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, table],
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

    // Fix: Function URL does not support JWT authorizer directly. 
    // We switch to ApiGatewayV2 (HTTP API) to enable JWT Auth via Cognito.
    const api = new sst.aws.ApiGatewayV2("IngestApi");

    // Add the Web Client with proper configuration using 'transform' for properties not exposed at high-level
    const webClient = auth.addClient("WebApp", {
      transform: {
        client: {
          callbackUrls: ["http://localhost:4321/google/callback", "https://dh2dhkfw596ym.cloudfront.net/google/callback"],
          logoutUrls: ["http://localhost:4321", "https://dh2dhkfw596ym.cloudfront.net"],
          allowedOauthFlows: ["code"],
          allowedOauthScopes: ["email", "profile", "openid"],
          supportedIdentityProviders: ["COGNITO"], // Add "Google" here once the IdP is configured
        }
      }
    });

    // Dynamically determine the region from the User Pool ARN to construct the issuer URL
    const region = auth.nodes.userPool.arn.apply(arn => arn.split(":")[3]);

    const authorizer = api.addAuthorizer({
        name: "Cognito",
        jwt: {
            issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${auth.id}`,
            audiences: [webClient.id],
        },
    });
    
    api.route("POST /ingest", {
      handler: "src/ingest.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket, auth],
      timeout: "60 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    // DEPLOY FRONTEND
    const site = new sst.aws.Astro("Web", {
      link: [api, auth, webClient], // Link API and Auth to the frontend
      environment: {
        PUBLIC_USER_POOL_ID: auth.id,
        PUBLIC_USER_POOL_CLIENT_ID: webClient.id,
        PUBLIC_API_URL: api.url,
      }
    });

    const dream = new sst.aws.Function("DreamFunction", {
      handler: "src/dreams.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
    });

    const lyrics = new sst.aws.Function("LyricsFunction", {
      handler: "src/lyrics.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
    });

    const fiction = new sst.aws.Function("FictionFunction", {
      handler: "src/fiction.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
    });

    const biographer = new sst.aws.Function("BiographerFunction", {
      handler: "src/biographer.handler",
      url: true, // Creates a public Lambda Function URL
      timeout: "60 seconds",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
    });

    return {
      site: site.url,
      api: api.url,
      dreamsEndpoint: dream.url,
      lyricsEndpoint: lyrics.url,
      fictionEndpoint: fiction.url,
      biographerEndpoint: biographer.url,
      librarianEndpoint: librarianTrigger.url,
      userPoolId: auth.id,
      userPoolClientId: webClient.id, // Access client ID from the client resource, not the pool
    };
  },
});
