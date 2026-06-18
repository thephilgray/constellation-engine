# Dynamic LLM-Generated Handoff Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded handoff-prompt boilerplate with an LLM-generated, repo-specific brief that proposes one original demo project (or an explainer when the repo is a poor fit) and directs the builder to log in `DIFFPRESS.md`.

**Architecture:** Insert one new Lambda step, `GenerateHandoff`, between `SeedIdeas` and `AwaitHandoff` in the Content Engine state machine. It runs Gemini over the repo metadata, README, existing Tavily coverage, and brain-dump seed ideas, then returns `{ mode, handoffPrompt }` in state. The README is fetched once (selected repo only) by upgrading the `enrichRepos` stub. The generated prompt rides the existing ledger → board → drawer path via a new `handoffPrompt` field; the old boilerplate stays only as a fallback.

**Tech Stack:** TypeScript, AWS Lambda, SST v3 (Step Functions), `@google/genai` (Gemini 2.5 Pro), `@octokit/rest`, Zustand (frontend), Vitest.

**Spec:** `docs/superpowers/specs/2026-06-18-dynamic-handoff-prompt-design.md`

**Conventions to follow:**
- TDD: pure functions get unit tests; Gemini-calling handlers are kept thin and are NOT unit-tested (mirrors `draftArticle.test.ts`, which tests only `buildDraftPrompt`/`parseDraftResponse`). Push all decision/fallback logic into pure functions so coverage lives there.
- Vitest gotcha: in `beforeEach`, never use an expression-arrow that returns a `Mock` (false-positive unhandled-rejection). Use a block body: `beforeEach(() => { ... })`.
- Run tests with `npx vitest run <path>`.

---

### Task 1: Extend state and record types

**Files:**
- Modify: `src/diffpress/types.ts`

- [ ] **Step 1: Add `mode` + `handoffPrompt` to `ContentEngineState` and `handoffPrompt` to `PublicationRecord`**

In `src/diffpress/types.ts`, find the `ContentEngineState` interface and add two fields (place them after `seedIdeas?` and before `handoff?`):

```typescript
  seedIdeas?: SeedIdea[];
  /** Article mode chosen by generateHandoff; draftArticle honors it authoritatively. */
  mode?: "narrative" | "explainer";
  /** LLM-generated handoff brief shown in the Ready-for-Dev drawer. */
  handoffPrompt?: string;
  handoff?: HandoffData;
```

In the `PublicationRecord` interface, add (place after `taskToken?` / near the AWAITING_HANDOFF fields):

```typescript
  /** LLM-generated handoff brief, persisted on the AWAITING_HANDOFF record. */
  handoffPrompt?: string;
```

- [ ] **Step 2: Verify the project still type-checks**

Run: `npx tsc --noEmit`
Expected: PASS (no new errors from these additions).

- [ ] **Step 3: Commit**

```bash
git add src/diffpress/types.ts
git commit -m "feat(diffpress): add mode + handoffPrompt to engine state and record types"
```

---

### Task 2: Fetch the real README in enrichRepos

**Files:**
- Modify: `src/diffpress/enrichRepos.ts`
- Test: `src/diffpress/enrichRepos.test.ts` (create)

The README fetch (octokit) is impure; the decode/truncate/compose logic is pure and gets the tests.

- [ ] **Step 1: Write failing tests for the pure helpers**

Create `src/diffpress/enrichRepos.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildDocumentation, README_CHAR_CAP } from "./enrichRepos";

describe("buildDocumentation", () => {
  it("uses the README when present", () => {
    const doc = buildDocumentation("acme/widget", "Widget desc", "# Real README\n\nUsage...");
    expect(doc).toContain("# Real README");
    expect(doc).toContain("Usage...");
  });

  it("falls back to description-only when README is null", () => {
    const doc = buildDocumentation("acme/widget", "Widget desc", null);
    expect(doc).toContain("acme/widget");
    expect(doc).toContain("Widget desc");
    expect(doc).not.toContain("README");
  });

  it("falls back to description-only when README is blank", () => {
    const doc = buildDocumentation("acme/widget", "Widget desc", "   \n  ");
    expect(doc).toContain("Widget desc");
  });

  it("truncates an over-long README to the cap with a marker", () => {
    const huge = "x".repeat(README_CHAR_CAP + 5000);
    const doc = buildDocumentation("acme/widget", "Widget desc", huge);
    expect(doc.length).toBeLessThan(README_CHAR_CAP + 200);
    expect(doc).toContain("[truncated]");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/diffpress/enrichRepos.test.ts`
Expected: FAIL — `buildDocumentation`/`README_CHAR_CAP` not exported.

- [ ] **Step 3: Implement the README fetch + pure helpers**

Replace the entire contents of `src/diffpress/enrichRepos.ts` with:

```typescript
// src/diffpress/enrichRepos.ts
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
import { putPayload } from "./lib/payloadStore";
import type { ContentEngineState, EnrichmentPayload } from "./types";

/** Max README characters kept in the enrichment payload (bounds prompt size/cost). */
export const README_CHAR_CAP = 8000;

/** Pure: compose the documentation field from the (optional) README, else description-only. */
export function buildDocumentation(
  repoName: string,
  description: string,
  readme: string | null
): string {
  const body = (readme ?? "").trim();
  if (!body) {
    return `# ${repoName}\n\n${description}`;
  }
  if (body.length > README_CHAR_CAP) {
    return `${body.slice(0, README_CHAR_CAP)}\n\n…[truncated]`;
  }
  return body;
}

/** Fetch the repo README (decoded). Returns null on missing file / non-repo / any error. */
async function fetchReadme(repoName: string): Promise<string | null> {
  const [owner, repo] = repoName.split("/");
  if (!owner || !repo) return null;
  try {
    const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
    const res = await octokit.rest.repos.getReadme({ owner, repo });
    const data = res.data as { content?: string; encoding?: string };
    if (!data.content) return null;
    const encoding = (data.encoding as BufferEncoding) ?? "base64";
    return Buffer.from(data.content, encoding).toString("utf-8");
  } catch (err) {
    console.warn(`[enrichRepos] no README for ${repoName}: ${(err as Error).message}`);
    return null;
  }
}

async function gatherEnrichment(state: ContentEngineState): Promise<EnrichmentPayload> {
  const { repo } = state;
  const readme = await fetchReadme(repo.repoName);
  return {
    repoName: repo.repoName,
    repoUrl: repo.repoUrl,
    documentation: buildDocumentation(repo.repoName, repo.description, readme),
    // STUB: HN/Reddit sentiment is still a placeholder; out of scope here.
    sentiment: [
      { source: "stub", summary: "Placeholder sentiment summary.", score: 0 },
    ],
    generatedAt: new Date().toISOString(),
  };
}

/** S3 key for an enrichment payload; slashes in repoName are flattened. */
function payloadKey(repoName: string): string {
  const safe = repoName.replace(/\//g, "-");
  return `enrichment/${Date.now()}/${safe}.json`;
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  const payload = await gatherEnrichment(state);
  const location = await putPayload(payloadKey(state.repo.repoName), payload);
  console.log(`[enrichRepos] wrote payload to s3://${location.bucket}/${location.key}`);
  return { ...state, enrichment: location };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/diffpress/enrichRepos.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/enrichRepos.ts src/diffpress/enrichRepos.test.ts
git commit -m "feat(diffpress): fetch real README into enrichment documentation"
```

---

### Task 3: generateHandoff — the meta-prompt (pure)

**Files:**
- Create: `src/diffpress/generateHandoff.ts`
- Test: `src/diffpress/generateHandoff.test.ts`

- [ ] **Step 1: Write failing tests for `buildMetaPrompt`**

Create `src/diffpress/generateHandoff.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildMetaPrompt } from "./generateHandoff";
import type { RepoCandidate, SeedIdea, EnrichmentPayload } from "./types";

const repo: RepoCandidate = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  description: "A widget toolkit",
  stars: 1234,
  language: "TypeScript",
  pushedAt: "2026-06-10T00:00:00.000Z",
  coverageSources: [
    { title: "Intro to Widget", url: "https://dev.to/x", domain: "dev.to", abstract: "A tour.", relevanceScore: 0.7 },
  ],
};

const enrichment: EnrichmentPayload = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  documentation: "# Widget\n\nA toolkit for widgets.",
  sentiment: [],
  generatedAt: "2026-06-15T00:00:00.000Z",
};

const seeds: SeedIdea[] = [{ id: "s1", text: "A dashboard that tracks plants", score: 0.8 }];

describe("buildMetaPrompt", () => {
  it("includes repo metadata, README docs, coverage, and seed ideas", () => {
    const p = buildMetaPrompt({ repo, documentation: enrichment.documentation, seedIdeas: seeds });
    expect(p).toContain("acme/widget");
    expect(p).toContain("https://github.com/acme/widget");
    expect(p).toContain("A toolkit for widgets.");
    expect(p).toContain("Intro to Widget");
    expect(p).toContain("dashboard that tracks plants");
  });

  it("instructs both narrative and explainer modes and the fit decision", () => {
    const p = buildMetaPrompt({ repo, documentation: "", seedIdeas: [] });
    expect(p.toLowerCase()).toContain("narrative");
    expect(p.toLowerCase()).toContain("explainer");
    expect(p.toLowerCase()).toContain("not");        // "not hello-world / trivial"
  });

  it("directs logging to DIFFPRESS.md at the demo repo root", () => {
    const p = buildMetaPrompt({ repo, documentation: "", seedIdeas: [] });
    expect(p).toContain("DIFFPRESS.md");
  });

  it("tells the model to differentiate from existing coverage", () => {
    const p = buildMetaPrompt({ repo, documentation: "", seedIdeas: seeds });
    expect(p.toLowerCase()).toContain("differentiate");
  });

  it("handles empty seeds and empty coverage without crashing", () => {
    const bare: RepoCandidate = { ...repo, coverageSources: [] };
    const p = buildMetaPrompt({ repo: bare, documentation: "", seedIdeas: [] });
    expect(p).toContain("acme/widget");
    expect(p).toContain("(none");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/diffpress/generateHandoff.test.ts`
Expected: FAIL — module/`buildMetaPrompt` not found.

- [ ] **Step 3: Implement `buildMetaPrompt` (and the file scaffold)**

Create `src/diffpress/generateHandoff.ts` with only what the pure function needs (the Gemini imports are added in Task 5):

```typescript
// src/diffpress/generateHandoff.ts
import type { RepoCandidate, SeedIdea } from "./types";

/** Pure: assemble the Gemini instruction that produces the handoff brief. */
export function buildMetaPrompt(input: {
  repo: RepoCandidate;
  documentation: string;
  seedIdeas: SeedIdea[];
}): string {
  const { repo, documentation, seedIdeas } = input;
  const coverage =
    (repo.coverageSources ?? [])
      .map((s) => `- "${s.title}" (${s.domain}) — ${s.abstract}`)
      .join("\n") || "(none found)";
  const seeds =
    seedIdeas.map((s) => `- ${s.text}`).join("\n") || "(none — invent an original idea)";
  return [
    `You are the assignment editor for DiffPress, a publication that covers emerging open-source projects through the lens of a real demo project built with them.`,
    ``,
    `Produce a Markdown "handoff brief" that a developer will follow to build a demo project featuring the open-source project below, and to log the build so the log becomes the first draft of an article.`,
    ``,
    `## Decide the mode first`,
    `- If this repo is a good basis for an original, NON-trivial demo project, choose "narrative".`,
    `- If it is NOT a good fit for any real demo idea (e.g. it is a library best shown by explanation, not a standalone build), choose "explainer".`,
    `Never propose a hello-world or trivial example. If the only honest demo would be trivial, choose "explainer" instead.`,
    ``,
    `## narrative mode`,
    `Propose ONE specific, real demo project that exercises this repo meaningfully. Use the author's seed ideas below as LOOSE inspiration — lean on one if it genuinely fits, otherwise invent an original idea. The demo MUST differentiate from the existing coverage listed below (find an angle those pieces miss; do not rebuild what is already written about). The brief must cover: what to build and why it is interesting; which specific repo features/APIs to exercise; and logging guidance.`,
    ``,
    `## explainer mode`,
    `A lighter brief: clone, run, and critically evaluate the repo. No standalone demo build is required.`,
    ``,
    `## Logging guidance (REQUIRED in both modes)`,
    `Instruct the developer to create a file named DIFFPRESS.md at the ROOT of the demo project repo and log there as they work. The log should capture: decisions and why; friction points, surprises, and rough edges; timings worth quoting; specific details about ${repo.repoName}; and a critical-evaluation section near the end. Frame the log as the first draft of a narrative, demo-centric article that features ${repo.repoName} as its subject.`,
    ``,
    `## Open-source project`,
    `- Name: ${repo.repoName}`,
    `- URL: ${repo.repoUrl}`,
    `- Description: ${repo.description || "(none)"}`,
    `- Primary language: ${repo.language ?? "(unknown)"}`,
    `- Stars: ${repo.stars}`,
    ``,
    `## Repo documentation (README)`,
    documentation || "(none available)",
    ``,
    `## Author's seed ideas (loose inspiration only)`,
    seeds,
    ``,
    `## Existing coverage (differentiate from these)`,
    coverage,
    ``,
    `## Output`,
    `Return a JSON object with two fields: "mode" (either "narrative" or "explainer") and "handoffMarkdown" (the full handoff brief in GitHub-flavored Markdown, beginning at a level-1 heading like "# Handoff — ${repo.repoName}").`,
  ].join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/diffpress/generateHandoff.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/generateHandoff.ts src/diffpress/generateHandoff.test.ts
git commit -m "feat(diffpress): add generateHandoff meta-prompt builder"
```

---

### Task 4: generateHandoff — response parsing + fallback (pure)

**Files:**
- Modify: `src/diffpress/generateHandoff.ts`
- Modify: `src/diffpress/generateHandoff.test.ts`

This is where the Gemini-failure / bad-output fallback lives, fully unit-tested.

- [ ] **Step 1: Add failing tests for `fallbackHandoffPrompt` and `resolveHandoff`**

Append to `src/diffpress/generateHandoff.test.ts`:

```typescript
import { fallbackHandoffPrompt, resolveHandoff } from "./generateHandoff";

describe("fallbackHandoffPrompt", () => {
  it("produces a runnable boilerplate brief naming the repo and DIFFPRESS.md", () => {
    const p = fallbackHandoffPrompt("acme/widget");
    expect(p).toContain("acme/widget");
    expect(p).toContain("DIFFPRESS.md");
  });
});

describe("resolveHandoff", () => {
  it("parses valid model output into mode + prompt", () => {
    const raw = JSON.stringify({ mode: "narrative", handoffMarkdown: "# Handoff — acme/widget\nBuild X." });
    expect(resolveHandoff(raw, "acme/widget")).toEqual({
      mode: "narrative",
      handoffPrompt: "# Handoff — acme/widget\nBuild X.",
    });
  });

  it("accepts explainer mode", () => {
    const raw = JSON.stringify({ mode: "explainer", handoffMarkdown: "# Handoff — acme/widget\nExplain it." });
    expect(resolveHandoff(raw, "acme/widget").mode).toBe("explainer");
  });

  it("falls back (no mode, boilerplate prompt) on empty output", () => {
    const r = resolveHandoff("", "acme/widget");
    expect(r.mode).toBeUndefined();
    expect(r.handoffPrompt).toContain("acme/widget");
    expect(r.handoffPrompt).toContain("DIFFPRESS.md");
  });

  it("falls back on non-JSON output", () => {
    const r = resolveHandoff("not json at all", "acme/widget");
    expect(r.mode).toBeUndefined();
    expect(r.handoffPrompt).toContain("DIFFPRESS.md");
  });

  it("falls back on JSON missing fields or invalid mode", () => {
    expect(resolveHandoff(JSON.stringify({ mode: "weird", handoffMarkdown: "x" }), "a/b").mode).toBeUndefined();
    expect(resolveHandoff(JSON.stringify({ handoffMarkdown: "x" }), "a/b").mode).toBeUndefined();
    expect(resolveHandoff(JSON.stringify({ mode: "narrative" }), "a/b").mode).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/diffpress/generateHandoff.test.ts`
Expected: FAIL — `fallbackHandoffPrompt`/`resolveHandoff` not exported.

- [ ] **Step 3: Implement the pure parser + fallback**

In `src/diffpress/generateHandoff.ts`, add after `buildMetaPrompt`:

```typescript
/** Pure: minimal boilerplate brief used when generation fails. */
export function fallbackHandoffPrompt(repoName: string): string {
  return [
    `# Handoff — ${repoName}`,
    ``,
    `Clone the repository and build a small but real demo project that uses it (avoid hello-world). If it is a poor fit for a demo, clone and critically evaluate it instead.`,
    ``,
    `## Logging`,
    `Create a \`DIFFPRESS.md\` file at the root of your demo project repo and log as you work: decisions, friction, timings, specific details about ${repoName}, and a critical evaluation near the end. This log is the first draft of the article.`,
    ``,
    `## Deliverable`,
    `Paste your demo project's GitHub URL and developer log below, then resume the workflow to draft the article.`,
  ].join("\n");
}

/** Pure: turn raw model text into { mode?, handoffPrompt }, falling back safely. */
export function resolveHandoff(
  rawText: string,
  repoName: string
): { mode?: "narrative" | "explainer"; handoffPrompt: string } {
  const text = (rawText ?? "").trim();
  if (text) {
    try {
      const obj = JSON.parse(text) as { mode?: unknown; handoffMarkdown?: unknown };
      const modeOk = obj.mode === "narrative" || obj.mode === "explainer";
      if (
        modeOk &&
        typeof obj.handoffMarkdown === "string" &&
        obj.handoffMarkdown.trim()
      ) {
        return { mode: obj.mode as "narrative" | "explainer", handoffPrompt: obj.handoffMarkdown };
      }
    } catch {
      // fall through to boilerplate
    }
  }
  console.warn(`[generateHandoff] using fallback prompt for ${repoName}`);
  return { handoffPrompt: fallbackHandoffPrompt(repoName) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/diffpress/generateHandoff.test.ts`
Expected: PASS (all `buildMetaPrompt`, `fallbackHandoffPrompt`, `resolveHandoff` tests).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/generateHandoff.ts src/diffpress/generateHandoff.test.ts
git commit -m "feat(diffpress): add generateHandoff response parsing + safe fallback"
```

---

### Task 5: generateHandoff — handler (thin orchestration)

**Files:**
- Modify: `src/diffpress/generateHandoff.ts`

The handler is thin and not unit-tested (mirrors `draftArticle` handler). All branches are covered by `resolveHandoff` tests: a thrown Gemini error sets `raw = ""`, which `resolveHandoff` maps to the fallback.

- [ ] **Step 1: Expand the imports at the top of the file**

In `src/diffpress/generateHandoff.ts`, replace the single type-import line from Task 3 with:

```typescript
import { GoogleGenAI, Type } from "@google/genai";
import { Resource } from "sst";
import { getPayload } from "./lib/payloadStore";
import type {
  ContentEngineState,
  RepoCandidate,
  SeedIdea,
  EnrichmentPayload,
} from "./types";

const MODEL = "gemini-2.5-pro";
```

(`RepoCandidate`/`SeedIdea` are used by `buildMetaPrompt`; the rest are used by the handler below.)

- [ ] **Step 2: Add the Gemini wrapper + handler at the end of the file**

```typescript
// Lazy init so importing this module in unit tests does not require SST Resource bindings.
let genAI: GoogleGenAI | undefined;
function getGenAI(): GoogleGenAI {
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value });
  }
  return genAI;
}

/** Thin wrapper around the Gemini structured-output call. Returns "" on any error. */
async function generateBrief(prompt: string): Promise<string> {
  try {
    const result = await getGenAI().models.generateContent({
      model: MODEL,
      contents: [{ text: prompt }],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            mode: { type: Type.STRING },
            handoffMarkdown: { type: Type.STRING },
          },
          required: ["mode", "handoffMarkdown"],
        },
      },
    });
    return result.text ?? "";
  } catch (err) {
    console.error(`[generateHandoff] Gemini call failed: ${(err as Error).message}`);
    return "";
  }
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  if (!state.enrichment?.key) {
    throw new Error("generateHandoff: missing enrichment payload location in state.");
  }
  const payload: EnrichmentPayload = await getPayload(state.enrichment.key);

  const prompt = buildMetaPrompt({
    repo: state.repo,
    documentation: payload.documentation,
    seedIdeas: state.seedIdeas ?? [],
  });
  const raw = await generateBrief(prompt);
  const { mode, handoffPrompt } = resolveHandoff(raw, state.repo.repoName);

  console.log(
    `[generateHandoff] ${state.repo.repoName} → mode=${mode ?? "fallback"} (${handoffPrompt.length} chars)`
  );
  return { ...state, mode, handoffPrompt };
}
```

- [ ] **Step 3: Verify the whole module type-checks and tests still pass**

Run: `npx tsc --noEmit && npx vitest run src/diffpress/generateHandoff.test.ts`
Expected: PASS — no unused-import errors now; all generateHandoff tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/diffpress/generateHandoff.ts
git commit -m "feat(diffpress): add generateHandoff Lambda handler"
```

---

### Task 6: Persist handoffPrompt in the ledger and notifyHandoff

**Files:**
- Modify: `src/diffpress/lib/ledger.ts`
- Modify: `src/diffpress/notifyHandoff.ts`
- Test: `src/diffpress/lib/ledger.test.ts`

- [ ] **Step 1: Add a failing test for handoffPrompt persistence**

In `src/diffpress/lib/ledger.test.ts`, add a test inside the existing `buildMarkAwaitingParams` describe block (create the block if absent):

```typescript
import { buildMarkAwaitingParams } from "./ledger";

describe("buildMarkAwaitingParams", () => {
  it("persists handoffPrompt when provided", () => {
    const params = buildMarkAwaitingParams("table", "acme/widget", {
      repoUrl: "https://github.com/acme/widget",
      taskToken: "tok",
      handoffPrompt: "# Handoff — acme/widget",
    });
    expect(params.UpdateExpression).toContain("handoffPrompt = :handoffPrompt");
    expect(params.ExpressionAttributeValues?.[":handoffPrompt"]).toBe("# Handoff — acme/widget");
  });

  it("stores null handoffPrompt when omitted", () => {
    const params = buildMarkAwaitingParams("table", "acme/widget", {
      repoUrl: "https://github.com/acme/widget",
      taskToken: "tok",
    });
    expect(params.ExpressionAttributeValues?.[":handoffPrompt"]).toBeNull();
  });
});
```

If the test file already imports `buildMarkAwaitingParams` and has a describe block, add only the two `it(...)` cases.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: FAIL — `handoffPrompt` not in the update expression / meta type.

- [ ] **Step 3: Update `buildMarkAwaitingParams` and `markAwaitingHandoff`**

In `src/diffpress/lib/ledger.ts`, change the `meta` parameter type and the update expression of `buildMarkAwaitingParams`:

```typescript
export function buildMarkAwaitingParams(
  table: string,
  repoName: string,
  meta: { repoUrl: string; taskToken: string; payloadKey?: string; handoffPrompt?: string }
): UpdateCommandInput {
  return {
    TableName: table,
    Key: { repoName },
    UpdateExpression:
      "SET #status = :awaiting, repoUrl = :repoUrl, taskToken = :taskToken, payloadKey = :payloadKey, handoffPrompt = :handoffPrompt, discoveredAt = if_not_exists(discoveredAt, :now)",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":awaiting": "AWAITING_HANDOFF",
      ":repoUrl": meta.repoUrl,
      ":taskToken": meta.taskToken,
      ":payloadKey": meta.payloadKey ?? null,
      ":handoffPrompt": meta.handoffPrompt ?? null,
      ":now": new Date().toISOString(),
    },
  };
}
```

Then widen the `markAwaitingHandoff` signature to forward the field:

```typescript
export async function markAwaitingHandoff(
  repoName: string,
  meta: { repoUrl: string; taskToken: string; payloadKey?: string; handoffPrompt?: string }
): Promise<void> {
  await docClient.send(
    new UpdateCommand(buildMarkAwaitingParams(tableName(), repoName, meta))
  );
}
```

- [ ] **Step 4: Pass handoffPrompt from notifyHandoff**

In `src/diffpress/notifyHandoff.ts`, update the `markAwaitingHandoff` call:

```typescript
  await markAwaitingHandoff(state.repo.repoName, {
    repoUrl: state.repo.repoUrl,
    taskToken,
    payloadKey,
    handoffPrompt: state.handoffPrompt,
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/diffpress/lib/ledger.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/lib/ledger.ts src/diffpress/lib/ledger.test.ts src/diffpress/notifyHandoff.ts
git commit -m "feat(diffpress): persist generated handoffPrompt on AWAITING_HANDOFF record"
```

---

### Task 7: Surface handoffPrompt through listHandoffs

**Files:**
- Modify: `src/diffpress/listHandoffs.ts`
- Test: `src/diffpress/listHandoffs.test.ts`

- [ ] **Step 1: Add a failing test for bucketBoard projection**

In `src/diffpress/listHandoffs.test.ts`, add a test (extend the existing `bucketBoard` describe block; create it if absent):

```typescript
import { bucketBoard } from "./listHandoffs";
import type { PublicationRecord } from "./types";

describe("bucketBoard handoffPrompt", () => {
  it("projects handoffPrompt onto readyForDev items", () => {
    const items: PublicationRecord[] = [
      {
        repoName: "acme/widget",
        status: "AWAITING_HANDOFF",
        repoUrl: "https://github.com/acme/widget",
        taskToken: "tok",
        handoffPrompt: "# Handoff — acme/widget",
      },
    ];
    const board = bucketBoard(items);
    expect(board.readyForDev[0].handoffPrompt).toBe("# Handoff — acme/widget");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/diffpress/listHandoffs.test.ts`
Expected: FAIL — `handoffPrompt` not present on the item type / not projected.

- [ ] **Step 3: Add the field to `HandoffItem` and the projection**

In `src/diffpress/listHandoffs.ts`, add to the `HandoffItem` interface:

```typescript
export interface HandoffItem {
  repoName: string;
  repoUrl?: string;
  taskToken?: string;
  discoveredAt?: string;
  handoffPrompt?: string;
}
```

And in `bucketBoard`, the `AWAITING_HANDOFF` case:

```typescript
      case "AWAITING_HANDOFF":
        board.readyForDev.push({
          repoName: item.repoName,
          repoUrl: item.repoUrl,
          taskToken: item.taskToken,
          discoveredAt: item.discoveredAt,
          handoffPrompt: item.handoffPrompt,
        });
        break;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/diffpress/listHandoffs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/listHandoffs.ts src/diffpress/listHandoffs.test.ts
git commit -m "feat(diffpress): surface handoffPrompt in listHandoffs board"
```

---

### Task 8: draftArticle honors state.mode

**Files:**
- Modify: `src/diffpress/draftArticle.ts`
- Test: `src/diffpress/draftArticle.test.ts`

- [ ] **Step 1: Add a failing test for the authoritative mode directive**

In `src/diffpress/draftArticle.test.ts`, add to the `buildDraftPrompt` describe block:

```typescript
  it("injects an authoritative mode directive when mode is provided", () => {
    const p = buildDraftPrompt({ repo, enrichment, notes: "thin notes", mode: "narrative" });
    expect(p).toContain("MODE DIRECTIVE: narrative");
  });

  it("omits the authoritative directive when mode is absent", () => {
    const p = buildDraftPrompt({ repo, enrichment, notes: "thin notes" });
    expect(p).not.toContain("MODE DIRECTIVE");
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: FAIL — `mode` not accepted / directive absent.

- [ ] **Step 3: Add an optional `mode` to `buildDraftPrompt`**

In `src/diffpress/draftArticle.ts`, change the `buildDraftPrompt` signature and inject a directive. Update the signature:

```typescript
export function buildDraftPrompt(input: {
  repo: RepoCandidate;
  enrichment: EnrichmentPayload;
  notes: string;
  mode?: "narrative" | "explainer";
}): string {
  const { repo, enrichment, notes, mode } = input;
```

Then, in the returned array, insert an authoritative directive line immediately after the existing `## Mode` block (after the line that ends with "thin notes -> a concise explainer." / the directive-honoring sentence). Add:

```typescript
    ...(mode
      ? [``, `MODE DIRECTIVE: ${mode} — the assignment editor has already chosen this mode. Use it; do not infer a different mode from the notes.`]
      : []),
```

Place this spread element in the array right after the mode-explanation strings and before the blank line preceding `## OSS project`.

- [ ] **Step 4: Pass state.mode from the handler**

In the `handler` of `src/diffpress/draftArticle.ts`, update the `buildDraftPrompt` call:

```typescript
  const prompt = buildDraftPrompt({ repo: state.repo, enrichment: payload, notes, mode: state.mode });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/draftArticle.ts src/diffpress/draftArticle.test.ts
git commit -m "feat(diffpress): draftArticle honors authoritative mode from state"
```

---

### Task 9: Wire GenerateHandoff into the SST state machine

**Files:**
- Modify: `sst.config.ts`

No unit test; verify by build. Note (from project memory): `sst diff` clobbers `sst-env.d.ts` and can break `tsc` until types regenerate — do NOT run `sst diff` as the gate here; use `npx tsc --noEmit` and rely on deployment in a later manual step.

- [ ] **Step 1: Link GITHUB_TOKEN to enrichRepos and add the GenerateHandoff function**

In `sst.config.ts`, inside the `contentEngineFns` object (around lines 472–481), update `enrichRepos`'s `link` to include `GITHUB_TOKEN`, and add a new `generateHandoff` function after `seedIdeas`:

```typescript
      enrichRepos: new sst.aws.Function("DiffPressEnrichRepos", {
        handler: "src/diffpress/enrichRepos.handler",
        link: [contentPayloadBucket, GITHUB_TOKEN],
        timeout: "60 seconds",
      }),
      seedIdeas: new sst.aws.Function("DiffPressSeedIdeas", {
        handler: "src/diffpress/seedIdeas.handler",
        link: [GEMINI_API_KEY, PINECONE_API_KEY],
        timeout: "60 seconds",
      }),
      generateHandoff: new sst.aws.Function("DiffPressGenerateHandoff", {
        handler: "src/diffpress/generateHandoff.handler",
        link: [GEMINI_API_KEY, contentPayloadBucket],
        timeout: "120 seconds",
      }),
```

- [ ] **Step 2: Add the state-machine state and splice it into the chain**

In the state-machine definition section, add a new state after `seedState` (around line 518) and before `awaitHandoffState`:

```typescript
    const generateHandoffState = sst.aws.StepFunctions.lambdaInvoke({
      name: "GenerateHandoff",
      function: contentEngineFns.generateHandoff,
      payload: "{% $states.input %}",
      output: "{% $states.result.Payload %}",
    });
```

Then update the chain (around lines 546–551) to insert it between `seedState` and `awaitHandoffState`:

```typescript
    const contentEngineDefinition = discoverState
      .next(enrichState)
      .next(seedState)
      .next(generateHandoffState)
      .next(awaitHandoffState)
      .next(draftState)
      .next(recordState);
```

- [ ] **Step 3: Verify the config type-checks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add sst.config.ts
git commit -m "feat(diffpress): add GenerateHandoff step to the content engine state machine"
```

---

### Task 10: Frontend — show the generated prompt in the drawer

**Files:**
- Modify: `src/components/diffpress/types.ts`
- Modify: `src/components/diffpress/services.ts`
- Modify: `src/components/diffpress/store.ts`

- [ ] **Step 1: Add `handoffPrompt` to the frontend types**

In `src/components/diffpress/types.ts`, add to `HandoffCard`:

```typescript
export interface HandoffCard {
  id: string;
  repo: string;
  desc: string;
  /** The Step Functions task token needed to resume this handoff (from the API). */
  taskToken?: string;
  /** Prefill for the resume form, when the discovered repo URL is known. */
  repoUrl?: string;
  /** LLM-generated handoff brief from the backend; falls back to boilerplate if absent. */
  handoffPrompt?: string;
}
```

And to the `HandoffsResponse.readyForDev` item shape:

```typescript
  readyForDev: {
    repoName: string;
    repoUrl?: string;
    taskToken?: string;
    discoveredAt?: string;
    handoffPrompt?: string;
  }[];
```

- [ ] **Step 2: Map it through the services layer**

In `src/components/diffpress/services.ts`, in the `readyForDev` mapping inside `fetchCandidates`:

```typescript
    readyForDev: board.readyForDev.map((h) => ({
      id: h.repoName,
      repo: h.repoName,
      desc: "Ready for a local-dev pass before drafting.",
      taskToken: h.taskToken,
      repoUrl: h.repoUrl,
      handoffPrompt: h.handoffPrompt,
    })),
```

- [ ] **Step 3: Use the generated prompt in openDrawer, with boilerplate fallback**

In `src/components/diffpress/store.ts`, update the `handoff` field in `openDrawer`:

```typescript
            handoff: card.handoffPrompt ?? buildHandoffPrompt(card.repo),
```

(Keep the `buildHandoffPrompt` function as the fallback; do not delete it.)

- [ ] **Step 4: Verify the frontend type-checks**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/diffpress/types.ts src/components/diffpress/services.ts src/components/diffpress/store.ts
git commit -m "feat(diffpress): render backend-generated handoff prompt in the drawer"
```

---

### Task 11: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS — all existing tests plus the new `enrichRepos`, `generateHandoff`, `ledger`, `listHandoffs`, and `draftArticle` cases.

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: SUCCESS.

- [ ] **Step 4 (manual, optional): Deploy and smoke-test**

`npm run deploy:prod`, trigger the Content Engine, and confirm a Ready-for-Dev card's drawer shows a repo-specific, LLM-generated brief that names a real demo idea (or an explainer) and instructs logging in `DIFFPRESS.md`. (Out of band — not part of the committed task list.)

---

## Notes for the implementer

- **Why the handler isn't unit-tested:** the codebase keeps Gemini-calling handlers thin and tests pure functions instead (see `draftArticle.test.ts`). In `generateHandoff`, every decision branch is in `resolveHandoff` (parse success, empty, non-JSON, bad fields) and `buildMetaPrompt`. A thrown Gemini error is caught in `generateBrief` and converted to `""`, which `resolveHandoff` already maps to the fallback — so the failure path is covered by the `resolveHandoff("")` test.
- **Mode flow:** `generateHandoff` sets `state.mode`; it survives the wait-for-token pause because `AwaitHandoff`'s output merges the pre-pause input (`$merge([$states.input, { handoff: ... }])`). `draftArticle` then reads `state.mode`.
- **Fallback coverage:** old `AWAITING_HANDOFF` records (pre-feature) have no `handoffPrompt`; the frontend `?? buildHandoffPrompt(...)` keeps those drawers working.
```
