I am building "Constellation Engine," a Second Brain application using SST v3, DynamoDB, Pinecone, and Gemini 2.0 Flash.

**Current System Status:**
1.  **Unified Lake:** Fully operational. Data is stored in DynamoDB and indexed in Pinecone.
2.  **Ingestion & Query:** "The Incubator" is live. The `/ingest` endpoint and Chat UI support both saving data and answering questions (RAG) using a unified "Intent Router."
3.  **Librarian Refactor:** "The Explorer" is partially refactored. `fetchContext` reads from DynamoDB, and `persistRecs` writes recommendations back to the lake.
4.  **Frontend:** The Chat UI displays "Thinking..." states, renders Markdown responses, and features a smart, auto-growing input with draft persistence.

**The Goal for This Session:**
We want to deepen the intelligence of the system by refining the Librarian's analysis capabilities and introducing "The Dreamer," a background synthesis agent.

**Tasks to Implement:**

1.  **Refine "The Explorer" (Librarian Logic):**
    *   Review `src/librarian/strategicAnalysis.ts` and `src/librarian/synthesizeInsights.ts`.
    *   Update them to leverage the rich metadata in `ConstellationRecord` (tags, sourceURL, mediaType) which is now available in DynamoDB, rather than just processing raw text blocks.
    *   Ensure the `fetchArticles` step filters for content that hasn't already been ingested (check against DynamoDB).

2.  **Implement "The Dreamer" (Serendipity Engine):**
    *   Create a new scheduled function (e.g., running nightly).
    *   It should pick a random "Seed Entry" from the Unified Lake.
    *   Perform a vector search to find *distantly related* items (lower similarity score threshold?).
    *   Use Gemini to synthesize a "Spark" or "Connection" between these seemingly unrelated items.
    *   Save this "Spark" as a new Entry in the Unified Lake.

3.  **Advanced RAG (The Incubator):**
    *   Add "Source Citation" to the Chat UI. When the AI answers a question, it should list the `sourceTitle` or `id` of the entries it used for context.
    *   (Optional) Implement hybrid search (Keyword + Vector) if Pinecone/DynamoDB setup allows, or improve retrieval with date filters.

Please start by analyzing `src/librarian/strategicAnalysis.ts` to see how it currently processes input.