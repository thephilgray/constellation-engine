# DiffPress board actions: dismiss + regenerate handoff

**Date:** 2026-06-19
**Status:** Approved (design)

## Problem

The DiffPress kanban board has no way to remove cards you don't care about, and
no way to re-roll a Ready-for-Dev handoff brief you don't like. Two clarifying
findings shaped this design:

1. **There is no queue limit.** The only cap is a display cap of 8 cards per
   Discovery sub-lane (`Dashboard.tsx` `LANE_RENDER_CAP`). Dismissing a card
   only "frees a slot" in the narrow case where a lane already holds more than 8
   repos and others are hidden beneath the cap.
2. **The engine never pulls from the Discovery backlog.** Each weekly
   `ContentEngine` run writes a batch of `DISCOVERED` rows but advances only the
   single top-ranked repo (`discoverRepos.ts` `laned[0]`) through to a
   Ready-for-Dev handoff. Every other `DISCOVERED` card is inert. Therefore
   "send a card back to Discovery for reprocessing" has no landing spot — there
   is nothing that would ever re-advance it.

Given (2), "reprocess" is scoped to **re-running the handoff brief in place** for
the same repo, keeping it a Ready-for-Dev card with a freshly generated brief.

## Constraints

- **Ready-for-Dev cards are paused Step Functions executions** holding a task
  token (`AwaitHandoff`, `waitForTaskToken`). Any action that removes such a card
  MUST release the execution (`SendTaskFailure`) or it hangs until the
  task-token timeout. The API already has `states:SendTaskFailure` permission.
- `generateHandoff` needs the enrichment payload (`state.enrichment.key`) and
  seed ideas, not just the ledger row. `payloadKey` is persisted to the ledger
  via `markAwaitingHandoff`, so it is recoverable; seed ideas are not persisted
  and are lost on a re-run (the brief falls back to "invent an original idea").

## Design

### 1. Ledger — new `DISMISSED` status

- No change needed to `bucketBoard`: it already drops unknown statuses, so a
  dismissed row stops rendering.
- No change needed to `batchGetExisting`: it already excludes any repo present in
  the ledger, so a dismissed repo never resurfaces in discovery.
- Add one mutation `markDismissed(repoName)` in `lib/ledger.ts`, mirroring the
  existing `markDrafting` / `markAwaitingHandoff` (flip `status` to `DISMISSED`).

### 2. Backend — one route `POST /api/board-action`

Request body: `{ repoName: string, action: "dismiss" | "regenerate-handoff" }`.
A single Lambda switches on `action`.

- **`dismiss`**
  - Read the ledger row.
  - If `status === "AWAITING_HANDOFF"`: `SendTaskFailure(taskToken)` to end the
    paused execution, then `markDismissed(repoName)`.
  - Otherwise (`DISCOVERED`): just `markDismissed(repoName)`.
- **`regenerate-handoff`** (only valid for `AWAITING_HANDOFF` rows)
  - Read the ledger row; rebuild a minimal `ContentEngineState`:
    `repo` reconstructed from the row's fields, `enrichment: { key: payloadKey }`,
    `seedIdeas: []`.
  - Reuse the existing pure functions from `generateHandoff.ts`:
    `buildMetaPrompt` → `generateBrief` → `resolveHandoff`.
  - Write the fresh `handoffPrompt` (and `mode`) back to the ledger row.
  - The paused execution and its task token are left untouched.

The handoff brief is a human-facing artifact only — `draftArticle` consumes
`repoUrl` + `developerLog` from the resume payload, not `handoffPrompt`. So
regenerating it in place is safe and does not affect the eventual draft.

### 3. Frontend

- **Discovery cards** (`DiscoveryArticle`, currently non-interactive): add a
  hover-revealed ✕ control in the corner → `dismissCard(repoName)`.
- **Ready-for-Dev**: the card already opens the handoff drawer on click, so the
  two actions live **in the drawer**, not on the card:
  - "Regenerate brief" → `regenerateHandoff(repoName)`, re-render the drawer
    body with the new brief.
  - "Dismiss" → `dismissCard(repoName)`, close the drawer and remove the card.
- **Store** (`store.ts`): add `dismissCard(repoName)` (optimistic removal from the
  relevant column) and `regenerateHandoff(repoName)` (await the new brief, update
  the open `handoffDoc`).
- **Services** (`services.ts`): add `dismissCard` and `regenerateHandoff` calls
  hitting `POST /api/board-action`.

## Out of scope

- Full seeded re-run of the whole pipeline for a single repo.
- Any change to discovery cadence (`rate(7 days)`) or velocity.
- Bulk / multi-select dismiss.
- Un-dismiss / restore. (A dismissed row stays in the table; resurfacing it is a
  manual DB edit for now.)

## Open dependency (verify at build time, not a design fork)

Confirm the enrichment payload behind `payloadKey` is still retrievable while a
card sits in Ready-for-Dev (payloads are not GC'd). If they are collected,
`regenerate-handoff` needs a different documentation source; dismiss is
unaffected.

## Success criteria

- Dismissing a Discovery card removes it from the board and it does not reappear
  in a later discovery run.
- Dismissing a Ready-for-Dev card removes it AND the underlying Step Functions
  execution terminates (verify it is no longer in `RUNNING` state).
- Regenerating a handoff produces a different brief for the same repo, the card
  stays in Ready-for-Dev, and the task token still resolves on resume.
