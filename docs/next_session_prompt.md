Constellation Engine / DiffPress — next session.

**As of 2026-06-20:** the DiffPress content pipeline (discovery → handoff → Gemini draft →
record) is built, deployed to prod, and e2e-verified, including board dismiss + regenerate.

**Biggest remaining gap: the publishing platform.** Today deploy/syndication is a frontend
mock (`services.ts` `deployArticle` + `PublishConsole.tsx`) and `recordPublication.ts` only
marks the ledger `PUBLISHED` — nothing actually publishes anywhere. Also outstanding: the
inline LLM reviewer editor (mock only), and two low-priority backend stubs (`enrichRepos`
sentiment, `seedIdeas` fallback).

Full status + the copy-paste handoff prompt to start the publishing work:
→ `docs/diffpress-content-engine-next-steps.md`

(Older subsystem — the Librarian/Second Brain reading-dashboard merge bug and archive-pruning
work — is documented in git history / earlier docs and is not the current focus.)
