# DiffPress Content Engine — Next Steps

**As of:** 2026-06-14. The backend Content Engine is implemented and merged to `main`
(merge commit `3d17d76`). This doc captures what remains and a ready-to-use handoff
prompt for the next recommended step.

## Current state

**Done & merged** (see `docs/superpowers/specs/2026-06-14-diffpress-content-engine-design.md`
and `docs/superpowers/plans/2026-06-14-diffpress-content-engine.md`):
- Step Functions workflow: DiscoverRepos → EnrichRepos → SeedIdeas → AwaitHandoff
  (paused via `lambdaInvoke integration:"token"`) → DraftArticle → RecordPublication.
- `PublicationLifecycle` DynamoDB table (PK `repoName`), `ContentPayloadBucket` S3 bucket,
  weekly `ContentEngineCron`, manual `ContentEngineTrigger` (function URL).
- `POST /api/publish-handoff` on the existing `IngestApi`, behind Cognito JWT, resumes the
  paused execution via `SendTaskSuccess`.
- 10 unit tests pass; `tsc` clean; `sst diff` synthesizes all resources.

**Never deployed.** The app has not been `sst deploy`'d with these resources yet.

## Remaining work

### 1. Wire the `/diffpress` UI to the backend  ← RECOMMENDED NEXT
The frontend (`src/components/diffpress/`) has async **service stubs** in
`src/components/diffpress/services.ts`: `fetchCandidates`, `publishHandoff`,
`deployArticle`, `triggerTechEditor` (SSE simulation). Wiring them surfaces a real gap the
spec deliberately deferred:

- **Missing read endpoint.** `notifyHandoff` persists `AWAITING_HANDOFF` items (carrying the
  `taskToken` + `payloadKey`) to `PublicationLifecycle`, but nothing exposes them. The UI's
  `fetchCandidates` has no API to call, and `publishHandoff` **cannot obtain the `taskToken`**
  needed to resume the workflow. → Need (at least) `GET /api/handoffs` returning pending
  handoffs, likely also a way to fetch the drafted article / enrichment payload.
- **Auth threading.** `/api/publish-handoff` is behind Cognito JWT; the frontend must attach
  the token. Follow the existing pattern used for `/ingest`, `/dashboard`, etc.
- **Service-contract mapping.** Confirm what `deployArticle` and `triggerTechEditor` should
  do. After `/api/publish-handoff` resumes, `draftArticle`→`recordPublication` already run
  server-side automatically — so `deployArticle` may be redundant or may mean something else.
  `triggerTechEditor` (SSE) has **no backend counterpart** yet; decide whether to build one
  or drop it.

This step has genuine design decisions, so it should be **brainstormed into a short spec**
before coding. First action: read `services.ts` + `store.ts` to pin the real frontend
contract.

### 2. Fill the three backend stubs
In priority order:
- **`draftArticle.ts` (`composeArticle`)** — replace the template with a real LLM call
  (Gemini via the existing `getGenAI()` in `src/utils.ts`). Highest value.
- **`enrichRepos.ts` (`gatherEnrichment`)** — real Exa/Tavily doc fetch + HN/Reddit sentiment.
  Decide whether to add `EXA_API_KEY`/`TAVILY_API_KEY` secrets.
- **`seedIdeas.ts`** — settle the **Pinecone namespace** (other modules query a named
  namespace e.g. `ideas`; this currently hits the default and will always fall through to the
  stub). Then replace the generate-fallback with a real generation path if desired.

### 3. Deploy + verify end-to-end
- Ensure secrets are set (`sst secret set ...` — the app already needs GITHUB_*, GEMINI,
  PINECONE, INGEST_API_KEY, GOOGLE_BOOKS_API_KEY).
- `sst deploy` (the repo uses `npm run deploy:prod` which strips Homebrew from PATH to avoid a
  conflicting `sst`).
- Note: running `sst diff`/`deploy` regenerates `sst-env.d.ts`; if it ever gets clobbered in a
  no-secrets context, restore with `git checkout -- sst-env.d.ts` (see the
  `sst-typegen-gotchas` memory).

## Minor cleanups (optional)
- `getByRepo` in `src/diffpress/lib/ledger.ts` is exported but unused — trim for YAGNI, or
  keep for the read endpoint in step 1.
- `/api/publish-handoff` grants `states:SendTaskFailure` but only `SendTaskSuccess` is called.

---

## Handoff prompt — Step 1 (UI ↔ backend integration)

> Copy-paste this into a fresh session to start the next recommended step.

```
We just merged the DiffPress Content Engine backend to main (see
docs/diffpress-content-engine-next-steps.md and
docs/superpowers/specs/2026-06-14-diffpress-content-engine-design.md). Now I want to wire the
/diffpress React UI to that backend.

Please start by brainstorming this integration into a short spec (use the brainstorming skill).
Before asking me questions, read these to ground the design:
- Frontend service stubs:   src/components/diffpress/services.ts
- Frontend store/state:     src/components/diffpress/store.ts
- Backend handlers:         src/diffpress/ (esp. notifyHandoff.ts, publishHandoff.ts,
                            lib/ledger.ts)
- API + auth wiring:        sst.config.ts (the IngestApi routes + Cognito authorizer pattern)

Key gap to design around: the workflow pauses at a Step Functions task-token state, and
notifyHandoff persists an AWAITING_HANDOFF item (with the taskToken) to the PublicationLifecycle
table — but there is NO endpoint to read those items, so the UI can't get the taskToken needed
to call POST /api/publish-handoff. So the integration almost certainly needs a new authenticated
read endpoint (e.g. GET /api/handoffs) plus possibly a way to fetch the drafted article.

Also resolve, during brainstorming:
- How the frontend obtains/sends the Cognito JWT (match existing /ingest, /dashboard usage).
- What deployArticle and triggerTechEditor (SSE) in services.ts should map to on the backend —
  note that after publish-handoff resumes, draftArticle -> recordPublication already run
  server-side automatically.

Match existing repo conventions (handlers under src/, link[]-based IAM, the JWT authorizer
already defined in sst.config.ts). Keep it minimal/YAGNI. End brainstorming with a written spec,
then a plan.
```
