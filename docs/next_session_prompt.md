I am building "Constellation Engine," a Second Brain application using SST v3, DynamoDB, Pinecone, and Gemini 2.5 Flash.

**Current System Status (2026-01-24):**
1.  **Unified Lake Architecture (ACHIEVED):**
    *   **Writes:** All new entries (`/reflect`, etc.) are written directly to **DynamoDB** and indexed in **Pinecone**.
    *   **Backups:** A DynamoDB Stream triggers a `githubBackup` worker to asynchronously save Markdown files to the GitHub repo.
    *   **Legacy Data:** **MIGRATION COMPLETE.** All 50+ legacy Markdown files have been successfully ingested into DynamoDB and Pinecone.
2.  **Command Center:**
    *   **Agents:** Fully operational on Gemini 2.5 Flash.
    *   **Reflect:** `/reflect` creates structured records in the Unified Lake.
3.  **Dashboards:**
    *   Currently served from **GitHub** (via `dashboard.ts`).
    *   Agents update these files directly.

**The Goal for This Session:**
"Sensory Expansion."
With the data foundation solid and fully migrated, we can now open the "ears" of the system.

**Potential Tasks:**

1.  **Voice Interface (The Recorder):**
    *   **Goal:** Add a microphone button to the Chat UI.
    *   **Implementation:** Client-side recording -> Upload to `/ingest` -> Whisper/Gemini transcription -> Intent Router -> Agent Trigger.
    *   *Vision:* "Note to self: I had a dream about flying..." -> Automatically routed to `/dream`.

2.  **Unified Dashboard Read (Optimization):**
    *   **Current:** `dashboard.ts` reads from GitHub API (slower, rate limits).
    *   **Goal:** Store the latest "Dashboard State" in DynamoDB (e.g., `PK=DASHBOARD#life_log`) and have the frontend read from there for instant loads.

3.  **Archive Strategy:**
    *   Automate moving old "Daily Pulse" items to archive files to keep the main dashboards lightweight.

**Immediate Next Step:**
Start with **Task 1 (Voice Interface)**. The backend is ready for `mediaType: 'audio'`. We need to build the frontend recording capability.
