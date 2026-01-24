I am building "Constellation Engine," a Second Brain application using SST v3, DynamoDB, Pinecone, and Gemini 2.5 Flash / 3.0 Pro.

**Current System Status:**
1.  **Unified Lake:** Data is stored in DynamoDB and indexed in Pinecone. The ingestion engine now supports **Global Search** across all memory namespaces (`biography`, `dreams`, `ideas`, `fiction`, `lyrics`).
2.  **Command Center:** A Chat UI with slash commands to trigger specialized agents.
    *   **Agents:** Biographer (`/reflect`), Architect (`/think`), Dreamer (`/dream`), Storyteller (`/fic`), Bard (`/lyrics`), Librarian (`/read`).
    *   **Recent Upgrades:**
        *   `/reflect` now supports a "no-argument" mode to refresh the dashboard without adding an entry.
        *   Agents and Query synthesis upgraded to **Gemini 3.0 Pro Preview** for deeper insights.
        *   Fixed "Daily Pulse" formatting and "Recovered Memories" structure in Life Log.
3.  **The Office (Dashboards):**
    *   **Mobile-Ready:** Responsive UI with collapsible sidebar and mobile menu.
    *   **Readable:** Polished Markdown rendering with `@tailwindcss/typography`, proper text wrapping, and sanitized output.
4.  **Backend:** Serverless functions with Cognito authentication.

**The Goal for This Session:**
"Sensory Expansion & Deep Storage."
We have fixed the core text interactions and visibility. Now we need to enable frictionless capture (Voice) and ensure our data management (Archives/Backups) scales with the user's life.

**Potential Tasks:**

1.  **Voice Interface (The Recorder):**
    *   **Goal:** Add a microphone button to the Chat UI.
    *   **Implementation:** Client-side recording -> Upload to `/ingest` -> Whisper/Gemini transcription -> Intent Router -> Agent Trigger.
    *   *Vision:* "Note to self: I had a dream about flying..." -> Automatically routed to `/dream`.

2.  **Archive & Pruning Strategy:**
    *   **Problem:** Markdown dashboards (Life Log, Idea Garden) will eventually get too large for the context window.
    *   **Task:** Implement an automated "Archivist" that moves old entries (e.g., previous months' "Daily Pulse" items) to `Archive/YYYY-MM.md` files while keeping the main dashboard concise.

3.  **Hybrid Search for "The Incubator":**
    *   We currently rely on Vector Search (Semantic).
    *   *Upgrade:* Add Keyword Search (BM25 or similar via Pinecone or simple filtering) to find specific names or terms that semantic search might miss.

4.  **Interactive Librarian:**
    *   Make the `/read` workflow conversational. Allow follow-up questions on recommended books or articles.

**Immediate Next Step:**
Focus on **Task 1 (Voice Interface)**. This unlocks the "capture on the go" capability essential for a true Second Brain. We need to update `ChatContainer.tsx` to handle media streams and ensure the backend `ingest.ts` (which supports `mediaType: 'audio'`) is correctly wired up.