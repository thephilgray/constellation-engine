I am building "Constellation Engine," a Second Brain application using SST v3, DynamoDB, Pinecone, and Gemini 3 Pro. We have just completed a major refactoring to a "Unified Lake" architecture.

**Current System Status:**
1.  **Infrastructure:** Deployed on AWS via SST. Includes Cognito User Pool, DynamoDB (Single Table), Pinecone Index, and an Astro frontend hosted on CloudFront.
2.  **Authentication:** Fully implemented. Frontend uses `aws-amplify` with a custom Login UI. API Gateway uses a JWT Authorizer.
3.  **Ingestion Pipeline:** Live. `POST /ingest` receives text -> routes via Gemini ("Intent Router") -> saves to DynamoDB & Pinecone.
4.  **Legacy Migration:** Completed. We successfully ran a "Lazarus" script to migrate old GitHub markdown files into the new DynamoDB/Pinecone setup.
5.  **Backup:** Active. A DynamoDB Stream triggers a Lambda worker that asynchronously commits every new entry back to GitHub as a Markdown file.
6.  **Chat UI:** Functional at `/chat`. It authenticates, sends messages to the API, and displays a "Saved!" confirmation. It supports Markdown rendering.

**The Goal for This Session:**
We need to transition the system from a "Passive Recorder" to an "Active Partner." Currently, the Chat UI only saves data; it does not answer questions or retrieve context.

**Remaining Tasks (to implement):**

1.  **Implement "The Incubator" (Retrieval & Conversation):**
    *   Update `src/ingest.ts` to handle *questions*.
    *   If the input is a query, perform a vector search (RAG) on Pinecone.
    *   Synthesize a response using Gemini 3 Pro with the retrieved context.
    *   Return the text response to the frontend (instead of just "Saved!").

2.  **Implement "The Explorer" (Librarian Refactor):**
    *   Review `src/librarian/*` functions.
    *   Ensure all background jobs (fetching articles, synthesizing insights) read from the new DynamoDB table instead of GitHub.
    *   Ensure the output of these jobs (recommendations) is stored back into the Unified Lake.

3.  **Frontend Polish:**
    *   Update the Chat UI to display the *actual* AI response returned from the backend.
    *   Add a visual indicator for "Thinking/Retrieving Context."

Please start by analyzing `src/ingest.ts` and proposing how to modify it to support both "Save" (Input) and "Answer" (Query) modes.
