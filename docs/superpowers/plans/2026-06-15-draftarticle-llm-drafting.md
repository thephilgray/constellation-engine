# draftArticle LLM Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `draftArticle` stub with a real Gemini 2.5 Pro call that drafts a demo-centric, notes-driven article, sourcing developer notes primarily from a `DIFFPRESS.md` file in the demo repo.

**Architecture:** A new `src/diffpress/lib/devNotes.ts` owns demo-repo notes sourcing (parse the repo slug, fetch `DIFFPRESS.md` via Octokit, assemble file + UI notes). `draftArticle.ts` keeps small pure functions (`buildDraftPrompt`, `parseDraftResponse`) plus a lazily-initialized Gemini client and a thin `handler` that orchestrates: read S3 payload → source notes → build prompt → generate (structured JSON) → parse → sanitize → return state.

**Tech Stack:** TypeScript, `@google/genai` (Gemini 2.5 Pro, structured output via `Type`), `@octokit/rest`, AWS SST (Resource bindings), vitest.

**Spec:** `docs/superpowers/specs/2026-06-15-draftarticle-llm-drafting-design.md`

---

## File Structure

- **Create** `src/diffpress/lib/devNotes.ts` — `parseRepoSlug` (pure), `assembleNotes` (pure), `fetchDevNotes` (Octokit; network boundary), `NOTES_FILENAME` const.
- **Create** `src/diffpress/lib/devNotes.test.ts` — unit tests for the two pure functions.
- **Modify** `src/diffpress/draftArticle.ts` — remove the `composeArticle` template; add `buildDraftPrompt` (pure), `parseDraftResponse` (pure), lazy `getGenAI`, `generateArticle` wrapper, and rewrite `handler`.
- **Create** `src/diffpress/draftArticle.test.ts` — unit tests for `buildDraftPrompt` and `parseDraftResponse`.
- **Modify** `sst.config.ts:454` — add `GITHUB_TOKEN` to the `draftArticle` function's `link`.

Network paths (`fetchDevNotes`, the Gemini call) are not exercised in tests, matching the spec.

---

## Task 1: devNotes pure helpers (`parseRepoSlug`, `assembleNotes`)

**Files:**
- Create: `src/diffpress/lib/devNotes.ts`
- Test: `src/diffpress/lib/devNotes.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/diffpress/lib/devNotes.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseRepoSlug, assembleNotes } from "./devNotes";

describe("parseRepoSlug", () => {
  it("parses a standard https GitHub URL", () => {
    expect(parseRepoSlug("https://github.com/acme/widget")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("strips a trailing .git", () => {
    expect(parseRepoSlug("https://github.com/acme/widget.git")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("ignores extra path segments", () => {
    expect(parseRepoSlug("https://github.com/acme/widget/tree/main")).toEqual({ owner: "acme", repo: "widget" });
  });

  it("returns null for non-GitHub URLs", () => {
    expect(parseRepoSlug("https://gitlab.com/acme/widget")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseRepoSlug("not a url")).toBeNull();
  });
});

describe("assembleNotes", () => {
  it("uses the file as primary and appends the UI log when both exist", () => {
    const out = assembleNotes("# File notes", "ui log line");
    expect(out).toContain("# File notes");
    expect(out).toContain("ui log line");
    expect(out.indexOf("# File notes")).toBeLessThan(out.indexOf("ui log line"));
  });

  it("returns the file notes alone when there is no UI log", () => {
    expect(assembleNotes("# File notes", "")).toBe("# File notes");
  });

  it("falls back to the UI log when there is no file", () => {
    expect(assembleNotes(null, "ui log line")).toBe("ui log line");
  });

  it("returns empty string when both are empty", () => {
    expect(assembleNotes(null, "   ")).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diffpress/lib/devNotes.test.ts`
Expected: FAIL — cannot resolve `./devNotes` / functions not exported.

- [ ] **Step 3: Write minimal implementation**

Create `src/diffpress/lib/devNotes.ts`:

```ts
// src/diffpress/lib/devNotes.ts

/** The conventional dev-notes filename expected at the demo repo root. */
export const NOTES_FILENAME = "DIFFPRESS.md";

/** Pure: extract { owner, repo } from a GitHub URL, or null if not a GitHub repo URL. */
export function parseRepoSlug(url: string): { owner: string; repo: string } | null {
  if (typeof url !== "string") return null;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/#?]+)/i);
  if (!m) return null;
  const owner = m[1];
  const repo = m[2].replace(/\.git$/i, "");
  if (!owner || !repo) return null;
  return { owner, repo };
}

/** Pure: combine file notes (primary) with the UI handoff log (supplement/fallback). */
export function assembleNotes(fileNotes: string | null, uiLog: string): string {
  const file = (fileNotes ?? "").trim();
  const ui = (uiLog ?? "").trim();
  if (file && ui) {
    return `${file}\n\n---\n\n## Additional notes (from handoff)\n\n${ui}`;
  }
  return file || ui;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/diffpress/lib/devNotes.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/lib/devNotes.ts src/diffpress/lib/devNotes.test.ts
git commit -m "feat(diffpress): add devNotes pure helpers (parseRepoSlug, assembleNotes)"
```

---

## Task 2: `fetchDevNotes` (Octokit network boundary)

**Files:**
- Modify: `src/diffpress/lib/devNotes.ts`

No unit test (network boundary per spec). Verified by typecheck + the integration in Task 5.

- [ ] **Step 1: Add the fetch function**

Add these imports at the top of `src/diffpress/lib/devNotes.ts`:

```ts
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";
```

Append to `src/diffpress/lib/devNotes.ts`:

```ts
/**
 * Fetch the conventional dev-notes file from the demo repo root.
 * Returns null on a bad/non-GitHub URL, a missing file, or any fetch error —
 * the caller falls back to the UI handoff log. Never throws.
 */
export async function fetchDevNotes(demoRepoUrl: string): Promise<string | null> {
  const slug = parseRepoSlug(demoRepoUrl);
  if (!slug) return null;
  try {
    const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
    const res = await octokit.rest.repos.getContent({
      owner: slug.owner,
      repo: slug.repo,
      path: NOTES_FILENAME,
    });
    const data = res.data as { content?: string; encoding?: string };
    if (!data.content) return null;
    const encoding = (data.encoding as BufferEncoding) ?? "base64";
    return Buffer.from(data.content, encoding).toString("utf-8");
  } catch (err) {
    console.warn(
      `[devNotes] could not fetch ${NOTES_FILENAME} from ${demoRepoUrl}: ${(err as Error).message}`
    );
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 3: Run the existing devNotes tests (still green)**

Run: `npx vitest run src/diffpress/lib/devNotes.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 4: Commit**

```bash
git add src/diffpress/lib/devNotes.ts
git commit -m "feat(diffpress): fetch DIFFPRESS.md from demo repo (graceful fallback)"
```

---

## Task 3: `buildDraftPrompt` (pure)

**Files:**
- Modify: `src/diffpress/draftArticle.ts`
- Test: `src/diffpress/draftArticle.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/diffpress/draftArticle.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildDraftPrompt } from "./draftArticle";
import type { RepoCandidate, EnrichmentPayload } from "./types";

const repo: RepoCandidate = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  description: "A widget toolkit",
  stars: 1234,
  language: "TypeScript",
};

const enrichment: EnrichmentPayload = {
  repoName: "acme/widget",
  repoUrl: "https://github.com/acme/widget",
  documentation: "Widget docs body.",
  sentiment: [{ source: "hackernews", summary: "People like it.", score: 0.8 }],
  generatedAt: "2026-06-15T00:00:00.000Z",
};

describe("buildDraftPrompt", () => {
  it("includes repo metadata, docs, sentiment, and notes", () => {
    const p = buildDraftPrompt({ repo, enrichment, notes: "I built a demo app." });
    expect(p).toContain("acme/widget");
    expect(p).toContain("https://github.com/acme/widget");
    expect(p).toContain("A widget toolkit");
    expect(p).toContain("TypeScript");
    expect(p).toContain("Widget docs body.");
    expect(p).toContain("People like it.");
    expect(p).toContain("I built a demo app.");
  });

  it("explains both modes and the directive-honoring rule", () => {
    const p = buildDraftPrompt({ repo, enrichment, notes: "" });
    expect(p).toContain("explainer");
    expect(p).toContain("narrative");
    expect(p.toLowerCase()).toContain("mode:");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: FAIL — `buildDraftPrompt` is not exported.

- [ ] **Step 3: Add the implementation**

In `src/diffpress/draftArticle.ts`, add the `RepoCandidate` and `EnrichmentPayload` types to the existing type import and add the function. Replace the current import line:

```ts
import type { ContentEngineState, DraftedArticle } from "./types";
```

with:

```ts
import type {
  ContentEngineState,
  DraftedArticle,
  RepoCandidate,
  EnrichmentPayload,
} from "./types";
```

Then add this exported function (place it above the existing `handler`):

```ts
/** Pure: assemble the full Gemini prompt from repo metadata, enrichment, and notes. */
export function buildDraftPrompt(input: {
  repo: RepoCandidate;
  enrichment: EnrichmentPayload;
  notes: string;
}): string {
  const { repo, enrichment, notes } = input;
  const sentiment =
    enrichment.sentiment
      .map((s) => `- (${s.source}, score ${s.score}) ${s.summary}`)
      .join("\n") || "- (none)";
  return [
    `You are the staff writer for DiffPress, a publication that covers emerging open-source projects through the lens of real demo projects built with them.`,
    ``,
    `Write a publishable Markdown article about the author's experience with the open-source project below.`,
    ``,
    `## Mode`,
    `Two modes are supported:`,
    `- "explainer": a neutral, informative piece about the OSS project; the author's demo is NOT the focus.`,
    `- "narrative": the story of building the author's demo project that used this OSS project; demo-centric, with the OSS project as a supporting subject.`,
    `If the author's notes contain an explicit directive (a line such as "mode: explainer" or "mode: narrative", or a natural-language instruction like "write this as a narrative about my build"), honor it.`,
    `Otherwise infer the mode from the depth of the notes: rich, detailed notes -> narrative; thin notes -> a concise explainer.`,
    `Do not manufacture opinions or filler. Include criticism or assessment only where the notes or community sentiment provide specific, substantive signal.`,
    ``,
    `## OSS project`,
    `- Name: ${repo.repoName}`,
    `- URL: ${repo.repoUrl}`,
    `- Description: ${repo.description || "(none)"}`,
    `- Stars: ${repo.stars}`,
    `- Primary language: ${repo.language ?? "(unknown)"}`,
    ``,
    `## Reference documentation`,
    enrichment.documentation || "(none)",
    ``,
    `## Community sentiment`,
    sentiment,
    ``,
    `## Author's notes (primary source — drives both content and mode)`,
    notes || "(none provided)",
    ``,
    `## Output`,
    `Return a JSON object with two fields: "title" (a concise, specific headline) and "articleMarkdown" (the full article in GitHub-flavored Markdown, beginning at a level-2 heading; do not repeat the title as an H1).`,
  ].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/draftArticle.ts src/diffpress/draftArticle.test.ts
git commit -m "feat(diffpress): add buildDraftPrompt (demo-centric, dual-mode)"
```

---

## Task 4: `parseDraftResponse` (pure)

**Files:**
- Modify: `src/diffpress/draftArticle.ts`
- Test: `src/diffpress/draftArticle.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `src/diffpress/draftArticle.test.ts` (and add `parseDraftResponse` to the existing import from `./draftArticle`):

```ts
import { parseDraftResponse } from "./draftArticle";

describe("parseDraftResponse", () => {
  it("parses a valid JSON response", () => {
    const raw = JSON.stringify({ title: "My Title", articleMarkdown: "## Body" });
    expect(parseDraftResponse(raw)).toEqual({ title: "My Title", articleMarkdown: "## Body" });
  });

  it("throws on empty output", () => {
    expect(() => parseDraftResponse("   ")).toThrow(/empty/i);
  });

  it("throws on invalid JSON", () => {
    expect(() => parseDraftResponse("not json")).toThrow(/valid JSON/i);
  });

  it("throws when a required field is missing", () => {
    expect(() => parseDraftResponse(JSON.stringify({ title: "x" }))).toThrow(/missing/i);
  });
});
```

Note: the import at the top of the file already imports `buildDraftPrompt`; combine into one line, e.g. `import { buildDraftPrompt, parseDraftResponse } from "./draftArticle";`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: FAIL — `parseDraftResponse` is not exported.

- [ ] **Step 3: Add the implementation**

Add to `src/diffpress/draftArticle.ts` (above `handler`):

```ts
/** Pure: parse and validate the model's JSON output into title + body. */
export function parseDraftResponse(rawText: string): {
  title: string;
  articleMarkdown: string;
} {
  const text = (rawText ?? "").trim();
  if (!text) {
    throw new Error("draftArticle: model returned empty output.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("draftArticle: model output was not valid JSON.");
  }
  const obj = parsed as { title?: unknown; articleMarkdown?: unknown };
  if (
    typeof obj.title !== "string" ||
    typeof obj.articleMarkdown !== "string" ||
    !obj.title.trim() ||
    !obj.articleMarkdown.trim()
  ) {
    throw new Error("draftArticle: model output missing title or articleMarkdown.");
  }
  return { title: obj.title, articleMarkdown: obj.articleMarkdown };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/diffpress/draftArticle.test.ts`
Expected: PASS (6 tests total in the file).

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/draftArticle.ts src/diffpress/draftArticle.test.ts
git commit -m "feat(diffpress): add parseDraftResponse with validation"
```

---

## Task 5: Wire the `handler` (lazy client + generate + orchestration)

**Files:**
- Modify: `src/diffpress/draftArticle.ts`

No network test (the Gemini call + Octokit are boundaries). Verified by the full suite + typecheck.

- [ ] **Step 1: Replace the stub handler and remove `composeArticle`**

The final `src/diffpress/draftArticle.ts` should read in full as below. Replace the entire file contents (this removes the old `composeArticle` template and keeps the `buildDraftPrompt` / `parseDraftResponse` functions added in Tasks 3–4):

```ts
// src/diffpress/draftArticle.ts
import { GoogleGenAI, Type } from "@google/genai";
import { Resource } from "sst";
import { getPayload } from "./lib/payloadStore";
import { fetchDevNotes, assembleNotes } from "./lib/devNotes";
import { sanitizeMarkdown } from "../utils";
import type {
  ContentEngineState,
  DraftedArticle,
  RepoCandidate,
  EnrichmentPayload,
} from "./types";

const MODEL = "gemini-2.5-pro";

// Lazy init so importing this module in unit tests does not require SST Resource bindings.
let genAI: GoogleGenAI | undefined;
function getGenAI(): GoogleGenAI {
  if (!genAI) {
    genAI = new GoogleGenAI({ apiKey: Resource.GEMINI_API_KEY.value });
  }
  return genAI;
}

/** Pure: assemble the full Gemini prompt from repo metadata, enrichment, and notes. */
export function buildDraftPrompt(input: {
  repo: RepoCandidate;
  enrichment: EnrichmentPayload;
  notes: string;
}): string {
  const { repo, enrichment, notes } = input;
  const sentiment =
    enrichment.sentiment
      .map((s) => `- (${s.source}, score ${s.score}) ${s.summary}`)
      .join("\n") || "- (none)";
  return [
    `You are the staff writer for DiffPress, a publication that covers emerging open-source projects through the lens of real demo projects built with them.`,
    ``,
    `Write a publishable Markdown article about the author's experience with the open-source project below.`,
    ``,
    `## Mode`,
    `Two modes are supported:`,
    `- "explainer": a neutral, informative piece about the OSS project; the author's demo is NOT the focus.`,
    `- "narrative": the story of building the author's demo project that used this OSS project; demo-centric, with the OSS project as a supporting subject.`,
    `If the author's notes contain an explicit directive (a line such as "mode: explainer" or "mode: narrative", or a natural-language instruction like "write this as a narrative about my build"), honor it.`,
    `Otherwise infer the mode from the depth of the notes: rich, detailed notes -> narrative; thin notes -> a concise explainer.`,
    `Do not manufacture opinions or filler. Include criticism or assessment only where the notes or community sentiment provide specific, substantive signal.`,
    ``,
    `## OSS project`,
    `- Name: ${repo.repoName}`,
    `- URL: ${repo.repoUrl}`,
    `- Description: ${repo.description || "(none)"}`,
    `- Stars: ${repo.stars}`,
    `- Primary language: ${repo.language ?? "(unknown)"}`,
    ``,
    `## Reference documentation`,
    enrichment.documentation || "(none)",
    ``,
    `## Community sentiment`,
    sentiment,
    ``,
    `## Author's notes (primary source — drives both content and mode)`,
    notes || "(none provided)",
    ``,
    `## Output`,
    `Return a JSON object with two fields: "title" (a concise, specific headline) and "articleMarkdown" (the full article in GitHub-flavored Markdown, beginning at a level-2 heading; do not repeat the title as an H1).`,
  ].join("\n");
}

/** Pure: parse and validate the model's JSON output into title + body. */
export function parseDraftResponse(rawText: string): {
  title: string;
  articleMarkdown: string;
} {
  const text = (rawText ?? "").trim();
  if (!text) {
    throw new Error("draftArticle: model returned empty output.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("draftArticle: model output was not valid JSON.");
  }
  const obj = parsed as { title?: unknown; articleMarkdown?: unknown };
  if (
    typeof obj.title !== "string" ||
    typeof obj.articleMarkdown !== "string" ||
    !obj.title.trim() ||
    !obj.articleMarkdown.trim()
  ) {
    throw new Error("draftArticle: model output missing title or articleMarkdown.");
  }
  return { title: obj.title, articleMarkdown: obj.articleMarkdown };
}

/** Thin wrapper around the Gemini structured-output call. */
async function generateArticle(prompt: string): Promise<string> {
  const result = await getGenAI().models.generateContent({
    model: MODEL,
    contents: [{ text: prompt }],
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          articleMarkdown: { type: Type.STRING },
        },
        required: ["title", "articleMarkdown"],
      },
    },
  });
  return result.text ?? "";
}

export async function handler(state: ContentEngineState): Promise<ContentEngineState> {
  if (!state.enrichment?.key) {
    throw new Error("draftArticle: missing enrichment payload location in state.");
  }
  if (!state.handoff) {
    throw new Error("draftArticle: missing handoff data in state.");
  }

  const payload = await getPayload(state.enrichment.key);
  const fileNotes = await fetchDevNotes(state.handoff.repoUrl);
  const notes = assembleNotes(fileNotes, state.handoff.developerLog);

  const prompt = buildDraftPrompt({ repo: state.repo, enrichment: payload, notes });
  const raw = await generateArticle(prompt);
  const { title, articleMarkdown } = parseDraftResponse(raw);

  const article: DraftedArticle = {
    title,
    articleMarkdown: sanitizeMarkdown(articleMarkdown),
    draftedAt: new Date().toISOString(),
  };

  console.log(
    `[draftArticle] drafted "${article.title}" (notes source: ${fileNotes ? "file+ui" : "ui-only"})`
  );
  return { ...state, article };
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Run the full unit suite**

Run: `npx vitest run`
Expected: PASS — all prior tests plus the new devNotes (9) and draftArticle (6) tests green.

- [ ] **Step 4: Commit**

```bash
git add src/diffpress/draftArticle.ts
git commit -m "feat(diffpress): draft articles with Gemini 2.5 Pro (notes-driven)"
```

---

## Task 6: Link `GITHUB_TOKEN` to the draftArticle function

**Files:**
- Modify: `sst.config.ts` (the `draftArticle` function definition, ~line 452-456)

- [ ] **Step 1: Add the secret to the link array**

In `sst.config.ts`, find:

```ts
      draftArticle: new sst.aws.Function("DiffPressDraftArticle", {
        handler: "src/diffpress/draftArticle.handler",
        link: [GEMINI_API_KEY, contentPayloadBucket],
        timeout: "60 seconds",
      }),
```

Change the `link` line to:

```ts
        link: [GEMINI_API_KEY, GITHUB_TOKEN, contentPayloadBucket],
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (`GITHUB_TOKEN` is already declared at the top of `sst.config.ts`).

- [ ] **Step 3: Commit**

```bash
git add sst.config.ts
git commit -m "chore(sst): link GITHUB_TOKEN to draftArticle for demo-repo note fetch"
```

---

## Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full unit suite**

Run: `npx vitest run`
Expected: PASS — all test files green (previously 5 files / 18 tests, now +2 files / +15 tests).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Production build**

Run: `npx astro build`
Expected: build succeeds (matches the project's existing build check).

- [ ] **Step 4: Confirm clean tree**

Run: `git status -sb`
Expected: working tree clean on branch `diffpress-draftarticle`.

---

## Self-Review (completed by plan author)

- **Spec coverage:** model/client (Tasks 3/5) ✓; structured JSON output + sanitizeMarkdown (Task 5) ✓; notes sourcing file→UI→empty (Tasks 1/2/5) ✓; `DIFFPRESS.md` filename (Task 1) ✓; directive-in-notes dual mode (Task 3) ✓; excluded inputs / `seedIdeas` not referenced ✓; error guards + empty/invalid output throw (Tasks 4/5) ✓; `GITHUB_TOKEN` link (Task 6) ✓; pure-function code shape + tests (Tasks 1/3/4) ✓; out-of-scope items not implemented ✓.
- **Lazy-client note:** the spec said module-level instantiation; the plan uses lazy `getGenAI` so the file is importable in unit tests without SST bindings. Same self-contained intent, strictly better for testability.
- **Type consistency:** `buildDraftPrompt`, `parseDraftResponse`, `fetchDevNotes`, `assembleNotes`, `parseRepoSlug`, `NOTES_FILENAME` names are identical across tasks; `RepoCandidate` / `EnrichmentPayload` / `DraftedArticle` / `ContentEngineState` match `src/diffpress/types.ts`.
- **No placeholders:** every code step contains complete code; every run step states the exact command and expected result.
