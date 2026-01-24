I am building "Constellation Engine," a Second Brain application using SST v3, DynamoDB, Pinecone, and Gemini 2.5 Flash.

**Current System Status (2026-01-24):**
1.  **Unified Lake Architecture (ACHIEVED):**
    *   **Writes:** All new entries (`/reflect`, etc.) are written directly to **DynamoDB** and indexed in **Pinecone**.
    *   **Backups:** A DynamoDB Stream triggers a `githubBackup` worker to asynchronously save Markdown files to the GitHub repo.
    *   **Legacy Data:** **MIGRATION COMPLETE.** All 50+ legacy Markdown files have been successfully ingested into DynamoDB and Pinecone, utilizing the `biography` namespace and correct historical dating.
2.  **Command Center:**
    *   **Agents:** Fully operational on Gemini 2.5 Flash.
    *   **Reflect:** `/reflect` creates structured records in the Unified Lake.
3.  **Dashboards:**
    *   **Read:** Refactored `src/functions/dashboard.ts` to fetch `DASHBOARD#<type>` records from DynamoDB.
    *   **Write:** **Refactored.** Agents (`biographerAsync`) now write generated dashboard content directly to DynamoDB (`DASHBOARD#life_log`, `STATE`).
    *   **Backup:** The `githubBackup` worker handles backing up the dashboard state to `00_Life_Log.md` via DynamoDB Streams.

**The Goal for This Session:**
"Dashboard Optimization & Unification."
With the data foundation solid and fully migrated, we must now ensure the "View" layer is as fast and robust as the "Data" layer.

**Potential Tasks:**

1.  **Unified Dashboard Read (COMPLETE):**
    *   **Refactored:** `dashboard.ts` now fetches from DynamoDB.
    *   **Schema:** Added support for `DASHBOARD#` PK and `Dashboard` type in `schemas.ts`.
    *   **Infra:** Updated `sst.config.ts` to link the table to the dashboard endpoint.

2.  **Unified Dashboard Write (COMPLETE):**
    *   **Action:** Updated `src/biographerAsync.ts` to read/write `DASHBOARD#life_log` from DynamoDB.
    *   **Action:** Updated `src/workers/githubBackup.ts` to handle `Dashboard` type and update `00_Life_Log.md`.
    *   **Result:** Dashboards are now fully decoupled from synchronous GitHub API calls.

3.  **Dashboard Content Intelligence (Refinement) (COMPLETE):**
    *   **Action:** Implemented `queryRecentEntries` in `dynamo.ts` to fetch "last 5 active days".
    *   **Action:** Updated `biographerAsync.ts` to inject recent history into the prompt.
    *   **Result:** "Daily Pulse" and "State of Mind" now use accurate, retrieved context. Constraints applied.

4.  **Archive Strategy - NEXT:**
    *   Automate moving old "Daily Pulse" items to archive files to keep the main dashboards lightweight.

5.  **Voice Interface (Nice to Have):**
    *   **Goal:** Add a microphone button to the Chat UI.
    *   **Status:** Backend ready (`mediaType: 'audio'`), but deprioritized in favor of core architectural performance (Dashboards).

**Immediate Next Step:**
Proceed to **Task 4 (Archive Strategy)**. We need to implement a mechanism to periodically prune the "Daily Pulse" and move older items to an archive (e.g., `01_Archive_2026.md` or a dedicated DynamoDB archive structure).