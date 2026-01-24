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
    *   Currently served from **GitHub** (via `dashboard.ts`).
    *   Agents update these files directly.

**The Goal for This Session:**
"Dashboard Optimization & Unification."
With the data foundation solid and fully migrated, we must now ensure the "View" layer is as fast and robust as the "Data" layer.

**Potential Tasks:**

1.  **Unified Dashboard Read (High Priority):**
    *   **Current:** `dashboard.ts` reads from GitHub API (slower, rate limits).
    *   **Goal:** Store the latest "Dashboard State" in DynamoDB (e.g., `PK=DASHBOARD#life_log`) and have the frontend read from there for instant loads.
    *   **Enabler:** This architectural change allows us to programmatically regenerate the dashboard state without constant GitHub commits.

2.  **Dashboard Content Intelligence (Refinement):**
    *   **The Daily Pulse:**
        *   **Issue:** Dates are currently incorrect (off by ~2 years) and list is stale.
        *   **Fix:** Biographer must query DynamoDB for the *last 5 active days* to build a sliding window summary (e.g., "Jan 20 - Jan 24").
    *   **State of Mind:** Limit input context to the past 7 days.
    *   **Narrative:** Ensure the most recent entry is always woven into the story.
    *   **Constraints:**
        *   "Recovered Memories": Limit to 6-8 items max.
        *   "Milestones" & "Themes": Consolidate to reduce visual bloat.

3.  **Unified Dashboard Write (High Priority):**
    *   **Current:** Agents (Biographer) update GitHub files directly.
    *   **Goal:** Agents should update the DynamoDB Dashboard record. A stream/worker can then backup this state to GitHub. This keeps the live app decoupled from GitHub latency.

3.  **Archive Strategy:**
    *   Automate moving old "Daily Pulse" items to archive files to keep the main dashboards lightweight.

4.  **Voice Interface (Nice to Have):**
    *   **Goal:** Add a microphone button to the Chat UI.
    *   **Status:** Backend ready (`mediaType: 'audio'`), but deprioritized in favor of core architectural performance (Dashboards).

**Immediate Next Step:**
Start with **Task 1 (Unified Dashboard Read)**. Refactor `src/functions/dashboard.ts` to fetch from DynamoDB instead of GitHub.