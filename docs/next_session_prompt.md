I am building "Constellation Engine," a Second Brain application using SST v3, DynamoDB, Pinecone, and Gemini 2.5 Flash.

**Current System Status (2026-01-25):**
1.  **Unified Lake Architecture (COMPLETE):**
    *   **Writes:** All entries (`/reflect`, `/think`, `/fic`, `/lyrics`, `/dream`, `/read`) write to **DynamoDB** and **Pinecone**.
    *   **Dashboards:** ALL dashboards (`life_log`, `idea_garden`, `story_bible`, `song_seeds`, `dream_analysis`, `reading_list`) are now persisted as `DASHBOARD#<type>` records in DynamoDB.
    *   **Backups:** `src/workers/githubBackup.ts` handles backing up *all* dashboards to their respective Markdown files in the repo (`00_Story_Bible.md`, etc.), decoupled from the write path.
    *   **Legacy:** All legacy file-based writes in handlers (`philosopher`, `fiction`, `lyrics`, `dreamer`) have been replaced with DynamoDB calls.

2.  **Reading List & Librarian:**
    *   **Dialectical Librarian:** Fixed Step Function data mapping (Parallel state output) and `GEMINI_API_KEY` linking. `/read` command now correctly synthesizes book recommendations.
    *   **Log Reading:** Implemented `log_reading` intent. Users can chat "I am reading [Book]" to automatically update the "Current Reading" section of the dashboard via `src/librarian/logBook.ts`.

3.  **Command Center:**
    *   **Help:** Updated `/help` to include new commands and the "Log Reading" feature.
    *   **Feedback:** Chat UI provides specific feedback ("Reading List updated!", "Saved!", etc.).

**The Goal for This Session:**
"System Refinement & Archival."
The core architecture is unified. Now we focus on long-term sustainability (archiving/pruning) and interaction polish.

**Completed Tasks:**
1.  **Unified Dashboard Read/Write:** Refactored all 6 agents/handlers to use DynamoDB.
2.  **Dashboard Content Intelligence:** "Life Log" and "Idea Garden" use recent history context. "Reading List" is updateable via natural language.
3.  **Infrastructure Fixes:** Resolved Step Function and Lambda config issues for the Librarian workflow.

**Prioritized Tasks:**

1.  **CRITICAL BUG: Reading Dashboard Conflict - NEXT:**
    *   **Issue:** The `/read` command (Dialectical Librarian) and the "Log Reading" feature (`src/librarian/logBook.ts`) generate incompatible dashboard formats. They overwrite each other instead of merging.
    *   **Symptom:** `/read` generates a fresh "Dialectical Librarian Recommendations" file, wiping out the "Current Reading" and "Archive" sections maintained by the logging feature.
    *   **Fix:** Refactor `src/librarian/synthesizeInsights.ts` (or `persistRecs.ts`) to *fetch* the existing `reading_list` dashboard and *merge* the new recommendations into the "## 🌟 Top Recommendations" section, strictly preserving the "Current Reading" and "Archive" sections.

2.  **Archive Strategy (Pruning):**
    *   **Problem:** Dashboards like "Life Log" (Daily Pulse) and "Reading List" (Archive) will grow indefinitely.
    *   **Goal:** Implement a periodic "Gardener" job (or extend existing agents) to move old items from the Dashboard *content* (Markdown) into a separate "Archive" file/record, keeping the main dashboard fresh and lightweight.
    *   *Note:* The `githubBackup` worker already saves individual entries to `Archive/YYYY/MM`, but the *Dashboards* themselves need content pruning.

3.  **Voice Interface:**
    *   **Goal:** Add a microphone button to the Chat UI.
    *   **Status:** Backend ready (`mediaType: 'audio'`), frontend implementation needed.

4.  **Frontend Polish:**
    *   **Dashboards:** Render Markdown with proper styling (currently raw text/simple markdown).
    *   **Tabs:** Consider a tabbed view for switching between Chat and specific Dashboards (Life Log, Ideas, Books) instead of a single modal.

**Immediate Next Step:**
Start with **Task 1 (Reading Dashboard Conflict)**. We must ensure that generating recommendations does not destroy the user's manual reading logs. Verify the merging logic in `persistRecs.ts` or `synthesizeInsights.ts`.