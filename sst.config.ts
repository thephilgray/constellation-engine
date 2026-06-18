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
    const TAVILY_API_KEY = new sst.Secret("TAVILY_API_KEY");

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
      filters: [{ dynamodb: { NewImage: { type: { S: ["Entry", "Dashboard"] } } } }]
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
        link: [GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, table, GEMINI_API_KEY],
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
        "recentEntries": "{% $states.input.fetchContextResult.recentEntries %}",
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
      })
    });

    const fetchArticlesState = sst.aws.StepFunctions.lambdaInvoke({
        name: "FetchArticles",
        function: librarianFunctions.fetchArticles,
        payload: {
            "devToTag": "{% $states.input.strategicAnalysisResult.articleQueries.devToTag %}",
            "hnQuery": "{% $states.input.strategicAnalysisResult.articleQueries.hnQuery %}",
            "arxivQuery": "{% $states.input.strategicAnalysisResult.articleQueries.arxivQuery %}",
            "existingUrls": "{% $states.input.fetchContextResult.allIngestedUrls %}"
        },
        output: {
            "articles": "{% $states.result.Payload %}",
            "recentEntries": "{% $states.input.fetchContextResult.recentEntries %}"
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
        "mapResult": "{% $states.input[0] %}",
        "articles": "{% $states.input[1].articles %}",
        "recentEntries": "{% $states.input[1].recentEntries %}"
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

    // ASYNC WORKERS
    const biographerAsync = new sst.aws.Function("BiographerAsync", {
        handler: "src/biographerAsync.handler",
        link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
        timeout: "120 seconds", // Give it plenty of time
    });

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

    api.route("POST /dream", {
      handler: "src/librarian/dreamer.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, table, auth, INGEST_API_KEY],
      timeout: "90 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    api.route("POST /reflect", {
      handler: "src/biographer.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket, biographerAsync],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    api.route("POST /fiction", {
      handler: "src/fiction.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
      timeout: "60 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    api.route("POST /lyrics", {
      handler: "src/lyrics.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
      timeout: "60 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    api.route("POST /think", {
      handler: "src/philosopher.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
      timeout: "60 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    // SHORTCUT ENDPOINTS (API Key authenticated inside Lambda, NO API Gateway JWT auth)
    api.route("POST /shortcut/ingest", {
      handler: "src/ingest.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket, auth],
      timeout: "60 seconds",
    });

    api.route("POST /shortcut/dream", {
      handler: "src/librarian/dreamer.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, table, auth, INGEST_API_KEY],
      timeout: "90 seconds",
    });

    api.route("POST /shortcut/reflect", {
      handler: "src/biographer.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket, biographerAsync],
      timeout: "30 seconds",
    });

    api.route("POST /shortcut/fiction", {
      handler: "src/fiction.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
      timeout: "60 seconds",
    });

    api.route("POST /shortcut/lyrics", {
      handler: "src/lyrics.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
      timeout: "60 seconds",
    });

    api.route("POST /shortcut/think", {
      handler: "src/philosopher.handler",
      link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY, table, bucket],
      timeout: "60 seconds",
    });

    api.route("POST /read", {
      handler: "src/librarian/trigger.handler",
      link: [dialecticalLibrarian],
      permissions: [{
        actions: ["states:StartExecution"],
        resources: [dialecticalLibrarian.arn],
      }],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    api.route("GET /dashboard", {
      handler: "src/functions/dashboard.handler",
      link: [table],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    // ===== DIFFPRESS CONTENT ENGINE — shared resources (declared here; used by API route below and SFN block after dreamer) =====

    // Phase 1 enrichment payloads
    const contentPayloadBucket = new sst.aws.Bucket("ContentPayloadBucket");

    // Publication ledger (PK: repoName). Lifecycle:
    // DISCOVERED -> AWAITING_HANDOFF -> DRAFTING -> PUBLISHED.
    const publicationLifecycle = new sst.aws.Dynamo("PublicationLifecycle", {
      fields: { repoName: "string", status: "string" },
      primaryIndex: { hashKey: "repoName" },
      globalIndexes: { "status-index": { hashKey: "status" } },
      ttl: "ttl",
    });

    // Rolling GH Archive signal buckets (PK: repoName, SK: signalKey).
    // Hourly ingest writes STAR#/RELEASE# per-hour buckets; TTL prunes the
    // window, and discoverRepos sums it for star-velocity ranking.
    const discoverySignals = new sst.aws.Dynamo("DiscoverySignals", {
      fields: { repoName: "string", signalKey: "string" },
      primaryIndex: { hashKey: "repoName", rangeKey: "signalKey" },
      ttl: "ttl",
    });

    // Pipeline Command Center config — single item (id: "current").
    // Drives engine state (active/paused/off), discovery mode, and velocity.
    const discoveryConfig = new sst.aws.Dynamo("DiscoveryConfig", {
      fields: { id: "string" },
      primaryIndex: { hashKey: "id" },
    });

    api.route("POST /api/publish-handoff", {
      handler: "src/diffpress/publishHandoff.handler",
      link: [auth, publicationLifecycle],
      permissions: [
        { actions: ["states:SendTaskSuccess", "states:SendTaskFailure"], resources: ["*"] },
      ],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    // Read the pending/published board (Ready for Dev + In Review columns).
    api.route("GET /api/handoffs", {
      handler: "src/diffpress/listHandoffs.handler",
      link: [auth, publicationLifecycle],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    // Read a single published article's markdown (?repo=owner/name).
    api.route("GET /api/articles", {
      handler: "src/diffpress/getArticle.handler",
      link: [auth, publicationLifecycle],
      timeout: "30 seconds",
    }, {
      auth: {
        jwt: {
          authorizer: authorizer.id,
        },
      },
    });

    // Read/write the Pipeline Command Center config (engine state, mode, velocity).
    for (const method of ["GET", "POST"] as const) {
      api.route(`${method} /api/discovery-config`, {
        handler: "src/diffpress/discoveryConfig.handler",
        link: [auth, discoveryConfig],
        timeout: "30 seconds",
      }, {
        auth: {
          jwt: {
            authorizer: authorizer.id,
          },
        },
      });
    }

    // DEPLOY FRONTEND
    const site = new sst.aws.Astro("Web", {
      link: [api, auth, webClient], // Link API and Auth to the frontend
      environment: {
        PUBLIC_USER_POOL_ID: auth.id,
        PUBLIC_USER_POOL_CLIENT_ID: webClient.id,
        PUBLIC_API_URL: api.url,
      }
    });

    const dreamer = new sst.aws.Cron("DreamerCron", {
      schedule: "rate(1 day)",
      job: {
        handler: "src/librarian/dreamer.handler",
        link: [GEMINI_API_KEY, PINECONE_API_KEY, PINECONE_INDEX_HOST, table, GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, INGEST_API_KEY],
        timeout: "90 seconds",
      }
    });

    // ===== DIFFPRESS CONTENT ENGINE — functions, state machine, trigger, cron =====

    const contentEngineFns = {
      discoverRepos: new sst.aws.Function("DiffPressDiscoverRepos", {
        handler: "src/diffpress/discoverRepos.handler",
        link: [GITHUB_TOKEN, publicationLifecycle, discoverySignals, discoveryConfig, TAVILY_API_KEY],
        timeout: "120 seconds",
      }),
      enrichRepos: new sst.aws.Function("DiffPressEnrichRepos", {
        handler: "src/diffpress/enrichRepos.handler",
        link: [contentPayloadBucket, GITHUB_TOKEN],
        timeout: "60 seconds",
      }),
      seedIdeas: new sst.aws.Function("DiffPressSeedIdeas", {
        handler: "src/diffpress/seedIdeas.handler",
        link: [GEMINI_API_KEY, PINECONE_API_KEY],
        timeout: "60 seconds",
      }),
      generateHandoff: new sst.aws.Function("DiffPressGenerateHandoff", {
        handler: "src/diffpress/generateHandoff.handler",
        link: [GEMINI_API_KEY, contentPayloadBucket],
        timeout: "120 seconds",
      }),
      notifyHandoff: new sst.aws.Function("DiffPressNotifyHandoff", {
        handler: "src/diffpress/notifyHandoff.handler",
        link: [publicationLifecycle],
        timeout: "30 seconds",
      }),
      draftArticle: new sst.aws.Function("DiffPressDraftArticle", {
        handler: "src/diffpress/draftArticle.handler",
        link: [GEMINI_API_KEY, GITHUB_TOKEN, contentPayloadBucket, publicationLifecycle],
        timeout: "60 seconds",
      }),
      recordPublication: new sst.aws.Function("DiffPressRecordPublication", {
        handler: "src/diffpress/recordPublication.handler",
        link: [publicationLifecycle],
        timeout: "30 seconds",
      }),
    };

    // ----- State machine definition -----
    const discoverState = sst.aws.StepFunctions.lambdaInvoke({
      name: "DiscoverRepos",
      function: contentEngineFns.discoverRepos,
      output: "{% $states.result.Payload %}",
    });

    const enrichState = sst.aws.StepFunctions.lambdaInvoke({
      name: "EnrichRepos",
      function: contentEngineFns.enrichRepos,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });

    const seedState = sst.aws.StepFunctions.lambdaInvoke({
      name: "SeedIdeas",
      function: contentEngineFns.seedIdeas,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });

    const generateHandoffState = sst.aws.StepFunctions.lambdaInvoke({
      name: "GenerateHandoff",
      function: contentEngineFns.generateHandoff,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });

    // Phase 2: paused wait-for-task-token state.
    const awaitHandoffState = sst.aws.StepFunctions.lambdaInvoke({
      name: "AwaitHandoff",
      function: contentEngineFns.notifyHandoff,
      integration: "token",
      payload: {
        taskToken: "{% $states.context.Task.Token %}",
        state: "{% $states.input %}",
      },
      // Preserve pre-pause state and merge in the resume payload (repoUrl + developerLog).
      output: "{% $merge([$states.input, { 'handoff': $states.result }]) %}",
    });

    const draftState = sst.aws.StepFunctions.lambdaInvoke({
      name: "DraftArticle",
      function: contentEngineFns.draftArticle,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });

    const recordState = sst.aws.StepFunctions.lambdaInvoke({
      name: "RecordPublication",
      function: contentEngineFns.recordPublication,
      payload: "{% $states.input %}",
    });

    const contentEngineDefinition = discoverState
      .next(enrichState)
      .next(seedState)
      .next(generateHandoffState)
      .next(awaitHandoffState)
      .next(draftState)
      .next(recordState);

    const contentEngine = new sst.aws.StepFunctions("ContentEngine", {
      definition: contentEngineDefinition,
    });

    // Manual HTTP trigger (mirrors LibrarianTrigger)
    const contentEngineTrigger = new sst.aws.Function("ContentEngineTrigger", {
      handler: "src/diffpress/trigger.handler",
      url: true,
      link: [contentEngine, discoveryConfig],
      permissions: [
        { actions: ["states:StartExecution"], resources: [contentEngine.arn] },
      ],
    });

    // Weekly cron — same handler, StartExecution permission.
    const contentEngineCron = new sst.aws.Cron("ContentEngineCron", {
      schedule: "rate(7 days)",
      job: {
        handler: "src/diffpress/trigger.handler",
        link: [contentEngine, discoveryConfig],
        permissions: [
          { actions: ["states:StartExecution"], resources: [contentEngine.arn] },
        ],
      },
    });

    // Hourly GH Archive ingest — streams the previous hour's event file and
    // folds star/release signals into DiscoverySignals for the discovery window.
    const eventIngestCron = new sst.aws.Cron("EventIngestCron", {
      schedule: "rate(1 hour)",
      job: {
        handler: "src/diffpress/ingestEvents.handler",
        link: [discoverySignals, discoveryConfig],
        timeout: "300 seconds",
        // 2 GB gives a full vCPU; gunzip + JSON.parse are CPU-bound, so this
        // roughly halves the run at ~flat GB-second cost.
        memory: "2048 MB",
      },
    });

    return {
      site: site.url,
      api: api.url,
      librarianEndpoint: librarianTrigger.url,
      userPoolId: auth.id,
      userPoolClientId: webClient.id, // Access client ID from the client resource, not the pool
      contentEngineTrigger: contentEngineTrigger.url,
      publicationTable: publicationLifecycle.name,
      contentPayloadBucket: contentPayloadBucket.name,
    };
  },
});
