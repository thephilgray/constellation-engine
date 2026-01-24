I am building "Constellation Engine," a Second Brain application using SST v3, DynamoDB, Pinecone, and Gemini 2.0 Flash.

**Current System Status:**
1.  **Unified Lake:** Data is stored in DynamoDB and indexed in Pinecone.
2.  **Ingestion:** "The Recorder" saves raw text faithfully (preserving the user's voice) while using AI for metadata extraction.
3.  **Query (RAG):** "The Incubator" provides answers with source citations displayed in the Chat UI.
4.  **Serendipity:** "The Dreamer" runs nightly to find connections between distant entries.
5.  **Interface:** A Chat UI with local `/help` command support.

**The Goal for This Session:**
"Command & Control: Enabling On-Demand Creativity."
We need to wire up the specialized agents (Biographer, Storyteller, Bard) to the Chat UI via slash commands, allowing the user to trigger creative synthesis on demand.

**Tasks to Implement:**

1.  **Frontend Command Routing:**
    *   Update `src/components/chat/ChatContainer.tsx` to handle slash commands (`/dream`, `/reflect`, `/fic`, `/lyrics`, `/read`).
    *   Instead of sending everything to `/ingest`, these commands should trigger their respective endpoints (or a unified command dispatcher).

2.  **Implement `/dream` (The Dreamer):**
    *   Expose the `src/librarian/dreamer.ts` logic via an API endpoint (it is currently just a cron job).
    *   Allow the user to trigger a dream cycle immediately.

3.  **Implement `/reflect` (The Biographer):**
    *   Wire up the `/biographer` endpoint.
    *   Command: `/reflect [optional: timeframe]` -> triggers a review of recent entries.

4.  **Implement `/fic` (The Storyteller):**
    *   Wire up the `/fiction` endpoint.
    *   Command: `/fic <idea/scene>` -> Saves as a fiction fragment and updates the Story Bible.

5.  **Implement `/lyrics` (The Bard):**
    *   Wire up the `/lyrics` endpoint.
    *   Command: `/lyrics <line>` -> Saves a lyric line and updates the Song Seeds dashboard.

6.  **Implement `/read` (The Librarian):**
    *   Command: `/read` or `/recommend`.
    *   Action: Triggers the "Dialectical Librarian" workflow OR fetches the latest "BookRecommendations.md" content from GitHub/DynamoDB and displays it in the chat.

7.  **Refinement:**
    *   Ensure all slash commands provide immediate feedback ("Processing...") and then render the result (e.g., the generated "Spark" or the updated "Story Bible" summary) in the chat window.

Please start by refactoring `ChatContainer.tsx` to support a generic command handler that can route to different API endpoints based on the slash command used.
