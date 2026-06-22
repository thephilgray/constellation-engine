# DiffPress Content Engine — Next Steps

**As of:** 2026-06-20. The discovery → handoff → draft → record pipeline is built,
deployed to prod, and e2e-verified. What remains is the **publishing platform** and the
**inline LLM editor** — both currently frontend mocks with no backend.

## Current state

**Done & deployed (prod):**
- Step Functions pipeline: DiscoverRepos → EnrichRepos → SeedIdeas → GenerateHandoff →
  AwaitHandoff (task-token pause) → DraftArticle → RecordPublication.
- Real discovery (GH Archive star-velocity + Tavily interest→coverage scoring), DynamoDB-backed.
- `draftArticle` does real Gemini drafting; `generateHandoff` produces repo-specific briefs.
- Board UI with dismiss (Discovery ✕) + regenerate-handoff; `GET /api/handoffs`,
  `POST /api/publish-handoff`, board-action Lambda — all live behind Cognito JWT.

**Mocks / not built (no backend):**
- **Publishing / syndication** — `services.ts` `deployArticle` + `PublishConsole.tsx` are pure
  frontend fakes (900ms delay, hardcoded "State of the Art: Helix" title). The pipeline's
  `recordPublication.ts` only marks the ledger `PUBLISHED` — **it publishes nowhere.**
- **Inline LLM reviewer (AI Tech Editor / "Marginalia")** — `triggerTechEditor` replays static
  `TECH_EDITOR_NOTES` over a simulated SSE stream. Review mode is a deliberate no-op in `store.ts`.
  `DraftEditor.tsx` is a real contenteditable editor but has zero LLM wiring.

## Remaining work

### 1. Publishing platform  ← RECOMMENDED NEXT (biggest gap)

Goal: configure all destinations in the app UI, **no webhook URLs / API keys / tokens hardcoded.**

Key reality check — there is **no shared webhook standard** across platforms:
- **dev.to (Forem):** real REST API — `POST /api/articles`, `api-key` header. ✅
- **Ghost / WordPress / Hashnode:** real APIs (Admin JWT / REST / GraphQL). ✅
- **Medium:** API effectively retired — treat as manual/unsupported. ⚠️
- **Substack:** no official publishing API — treat as manual/unsupported. ⚠️
- **Custom personal site:** site exposes a publish webhook; engine POSTs the article to it. ✅

Proposed minimal design (brainstorm before coding):
- One generic **HTTP publish target** = `{ url, authHeaderName, secretRef, bodyTemplate }`,
  covering custom blogs + dev.to/Ghost/WP/Hashnode. Thin per-platform adapter only where the API
  genuinely deviates. Unsupported platforms marked manual, not faked.
- **Destinations config** stored in DynamoDB (per-user). API keys/tokens in a secret store
  (SST Secret / SSM) referenced **by name** — never the raw token in the config record.
- **Config page** in the app UI to manage destinations + which secret each uses.
- Replace/extend the `recordPublication` terminal step to actually POST to each enabled destination.
- Reuse the `generateHandoff` Lambda pattern to produce a "set up this publish webhook on your
  site" brief for personal sites we own.

This has real branching decisions (v1 platform set, secret-store choice) → **brainstorm into a
short spec first.**

### 2. Inline LLM reviewer editor
Wire `DraftEditor.tsx` to a real model. Decide: streaming margin notes (real SSE backend for
`triggerTechEditor`) vs. inline accept/reject suggestions in the contenteditable. Currently
mock-only and review mode is disabled. Separate effort from publishing.

### 3. Minor backend stubs (low priority)
- `enrichRepos.ts:50` — HN/Reddit sentiment is a hardcoded placeholder `{ source: "stub", score: 0 }`.
- `seedIdeas.ts` — empty-Pinecone fallback emits one templated idea; confirm the namespace and
  replace if desired.

## Notes
- Deploy via `npm run deploy:prod` (strips Homebrew from PATH to avoid a conflicting `sst`).
- `sst diff`/`deploy` regenerates `sst-env.d.ts`; if clobbered in a no-secrets context,
  `git checkout -- sst-env.d.ts` (see `sst-typegen-gotchas` memory).
- Engine only advances `laned[0]`/the running execution; the DISCOVERED backlog is inert.

---

## Handoff prompt — Step 1 (publishing platform)

> Copy-paste into a fresh session to start the next recommended step.

```
I want to build the DiffPress publishing platform (see
docs/diffpress-content-engine-next-steps.md). Today deploy/syndication is a frontend mock
(services.ts deployArticle + PublishConsole.tsx) and recordPublication.ts only marks the
ledger PUBLISHED — nothing actually publishes anywhere.

Please brainstorm this into a short spec (use the brainstorming skill) before any code.
Ground the design by reading:
- Frontend mock + UI:   src/components/diffpress/services.ts, PublishConsole.tsx, store.ts
- Pipeline end:         src/diffpress/recordPublication.ts, lib/ledger.ts
- API + auth + secrets: sst.config.ts (IngestApi routes, Cognito authorizer, SST secrets)

Requirements:
- Configure ALL destinations in the app UI — no webhook URLs / API keys / tokens hardcoded.
- Generic HTTP publish target (url + auth header + body template) covering custom blogs and
  dev.to/Ghost/WP/Hashnode; per-platform adapter only where the API deviates. Medium/Substack
  have no usable publishing API — mark them manual/unsupported, don't fake them.
- Custom personal site = a publish webhook the site exposes; engine POSTs the article to it.
  Reuse the generateHandoff pattern to produce a "set up this webhook" brief.
- Destinations config in DynamoDB; secrets in SST Secret/SSM referenced by name.

Match repo conventions (handlers under src/, link[]-based IAM, existing JWT authorizer).
Keep it minimal/YAGNI. End brainstorming with a written spec, then a plan.
```
