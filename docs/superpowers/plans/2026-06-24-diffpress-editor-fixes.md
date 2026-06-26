# DiffPress Editor Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the silently-failing AI review (it exceeds API Gateway's 30s cap), declutter the editor per the new design (autosave status, version-history drawer, single docked revise bar), and make links in the editor inspectable/editable.

**Architecture:** Three independent phases.
- **Phase 1 (AI streaming):** Move the three AI actions off the 30s-capped HTTP API onto a **Lambda Function URL with response streaming (SSE)**. Verify the Cognito JWT in-handler (Function URLs can't use the API Gateway authorizer — already documented at `sst.config.ts:194`). Stream `review` notes as JSONL and `revise` markdown as raw text, so the UI reveals content as the model produces it — replacing today's faked `setTimeout` reveal.
- **Phase 2 (redesign):** Pure-frontend restructure of `DraftEditor` controls. No backend.
- **Phase 3 (links):** Pure-frontend editor-UX gap. Links already round-trip through markdown (Turndown ↔ marked); the only miss is there's no way to see/edit/remove an existing link's URL.

Phases are independently shippable. Recommended order: 1 → 2 → 3, but any order works.

**Tech Stack:** SST v3 (`sst.aws.Function`), AWS Lambda response streaming (`awslambda.streamifyResponse`), `aws-jwt-verify` (new dep), `@google/genai` (`generateContentStream`), React + Zustand, Astro island, Tailwind, Vitest.

## Global Constraints

- **Model:** `gemini-2.5-pro` (current `articleAI.ts:8`). Streaming keeps pro viable. *Fallback if you abandon Phase 1:* changing `MODEL` to `gemini-2.5-flash` is the one-line unblock — faster (~8-12s), fits under 30s for review/reply, no streaming.
- **Auth:** Cognito JWT. Issuer `https://cognito-idp.<region>.amazonaws.com/<userPoolId>`; audience/clientId = `webClient.id` (`sst.config.ts:199`, `:214-219`). The browser already sends the **id token** as `Authorization: Bearer <token>` (`src/lib/authedApi.ts`).
- **API Gateway HTTP API integration timeout is hard-capped at 30,000 ms and cannot be raised.** This is the root cause; do not try to bump a timeout to fix Phase 1.
- **Markdown is canonical.** Editor seeds from markdown via `mdToHtml`, serializes back via `htmlToMd` (`src/components/diffpress/markdownHtml.ts`). Don't break the round-trip.
- **Tests:** Vitest, no new frameworks. Run `npx vitest run <file>`. Type-check with `npx tsc --noEmit`. Build with `npm run build`.
- **Dieter Rams aesthetic** — match existing `dp-*` Tailwind tokens and the calm, quiet visual language of the surrounding components.

---

## Phase 1 — AI review/revise over a streaming Function URL (SSE)

### Root cause (verified, do not re-investigate)

- The `articleAI` Lambda code is correct: a **direct `aws lambda invoke` returns 200 with valid notes in ~5-9s.**
- All four article routes run on the **HTTP API (`IngestApi`)**, whose integration timeout is **30,000 ms** on every route (`aws apigatewayv2 get-integration`).
- CloudWatch for the real HoldSpeak review: **`Duration: 34640.86 ms`** — pro completed in ~34.6s, but API Gateway returned **503 at 30s** and discarded the result.
- `store.runReview`'s `catch` swallows the 503 → `reviewing:false`, `notes:[]` → "spins, then nothing." `reply` and `revise` (full rewrite, slower) have the same ceiling.

### File Structure

- **Create** `src/diffpress/articleAIStream.ts` — streaming Function URL handler (`streamifyResponse`). Reuses the pure builders/parsers already exported from `articleAI.ts`.
- **Create** `src/diffpress/jwtAuth.ts` — verify a Cognito JWT from a Function URL event; returns `userId` or throws.
- **Modify** `src/diffpress/articleAI.ts` — export a reusable `getGenAI()` + the existing builders (already exported) for the stream handler to import. No behavior change to the existing buffered handler (keep it as fallback).
- **Modify** `sst.config.ts` — add `DiffPressArticleAIStream` Function with `url: true`, `streaming: true`, linked to `GEMINI_API_KEY` + `auth`; export its URL. Remove the `POST /api/articles/ai` route (or leave it as buffered fallback — see Task 1.7).
- **Modify** `src/components/diffpress/services.ts` — replace `runReview`/`reviseArticle` with streaming variants that read the Function URL response body; add a `STREAM_URL` import.
- **Modify** `src/lib/amplify.ts` (or wherever `API_URL` is defined) — add `export const AI_STREAM_URL` from the new env var.
- **Modify** `src/components/diffpress/store.ts` — `runReview`/`reviseArticle` consume the stream and append notes / replace markdown incrementally; delete the `setTimeout` fake-reveal block.
- **Test** `src/diffpress/jwtAuth.test.ts`, `src/diffpress/articleAIStream.test.ts` (pure parts only).

### Interfaces

- **Produces (backend):**
  - `verifyJwt(event): Promise<string>` — returns Cognito `sub`; throws `Error("unauthorized")` on missing/invalid token. (`src/diffpress/jwtAuth.ts`)
  - Streaming endpoint `POST <AI_STREAM_URL>`. Request body identical to today's `/api/articles/ai` (`{action, repo, articleMarkdown, ...}`). Response is `text/event-stream`:
    - `review`: emits `data: {"note": <ReviewNote>}\n\n` per note, then `data: {"done": true}\n\n`.
    - `revise`: emits `data: {"chunk": "<markdown text>"}\n\n` repeatedly, then `data: {"title": "<title>", "done": true}\n\n`.
    - `reply`: stays buffered (short, fits under 30s) — keep on the existing API Gateway route. **Do not move `reply`.**
    - On error: `data: {"error": "<message>"}\n\n` then close.
- **Produces (frontend services):**
  - `runReviewStream(repo, articleMarkdown, onNote: (n: ReviewNote) => void): Promise<void>`
  - `reviseArticleStream(repo, articleMarkdown, instruction, onChunk: (md: string) => void): Promise<{ title: string }>`
- **Consumes:** `ReviewNote` (`src/components/diffpress/types.ts:142`), `getGenAI`/`buildReviewPrompt`/`parseReviewResponse`/`buildRevisePrompt`/`parseDraftResponse` (`src/diffpress/articleAI.ts`).

---

### Task 1.1: Add `aws-jwt-verify` and the JWT verifier

**Files:**
- Modify: `package.json` (dependency)
- Create: `src/diffpress/jwtAuth.ts`
- Test: `src/diffpress/jwtAuth.test.ts`

- [ ] **Step 1: Install the dependency**

```bash
npm install aws-jwt-verify
```

- [ ] **Step 2: Write the failing test** (`src/diffpress/jwtAuth.test.ts`)

Test the pure token-extraction helper (don't hit Cognito in unit tests):

```ts
import { describe, it, expect } from "vitest";
import { extractBearer } from "./jwtAuth";

describe("extractBearer", () => {
  it("pulls the token from the Authorization header (any case)", () => {
    expect(extractBearer({ authorization: "Bearer abc.def.ghi" })).toBe("abc.def.ghi");
    expect(extractBearer({ Authorization: "Bearer abc.def.ghi" })).toBe("abc.def.ghi");
  });
  it("throws when missing or malformed", () => {
    expect(() => extractBearer({})).toThrow("unauthorized");
    expect(() => extractBearer({ authorization: "Token x" })).toThrow("unauthorized");
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npx vitest run src/diffpress/jwtAuth.test.ts`
Expected: FAIL — `extractBearer` not exported.

- [ ] **Step 4: Implement** (`src/diffpress/jwtAuth.ts`)

```ts
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { Resource } from "sst";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** Pull a bearer token out of Function URL headers (header casing varies). */
export function extractBearer(headers: Record<string, string | undefined>): string {
  const raw = headers.authorization ?? headers.Authorization ?? "";
  const m = /^Bearer\s+(.+)$/.exec(raw);
  if (!m) throw new Error("unauthorized");
  return m[1];
}

// Lazy singleton — building the verifier fetches the JWKS once and caches it.
let verifier: ReturnType<typeof CognitoJwtVerifier.create> | undefined;
function getVerifier() {
  if (!verifier) {
    verifier = CognitoJwtVerifier.create({
      userPoolId: Resource.UserPoolId.value,
      tokenUse: "id",
      clientId: Resource.WebClientId.value,
    });
  }
  return verifier;
}

/** Verify the Cognito id token on a Function URL event; return the user `sub`. */
export async function verifyJwt(event: APIGatewayProxyEventV2): Promise<string> {
  const token = extractBearer(event.headers ?? {});
  const payload = await getVerifier().verify(token);
  return payload.sub;
}
```

> NOTE: `Resource.UserPoolId` / `Resource.WebClientId` must be linkable. In `sst.config.ts`, add `Linkable` values (or link `auth` + a small `sst.Linkable` exposing the user pool id and client id) so the handler can read them. If `Resource.<X>` typing isn't generated yet, cast via `(Resource as any)` until `sst dev`/`sst diff` regenerates `sst-env.d.ts` (known repo gotcha — SST type-gen clobbers the file).

- [ ] **Step 5: Run it, verify it passes**

Run: `npx vitest run src/diffpress/jwtAuth.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/diffpress/jwtAuth.ts src/diffpress/jwtAuth.test.ts
git commit -m "feat(diffpress): add Cognito JWT verifier for Function URL auth"
```

---

### Task 1.2: Streaming handler — review (JSONL) and revise (raw markdown)

**Files:**
- Create: `src/diffpress/articleAIStream.ts`
- Modify: `src/diffpress/articleAI.ts` (ensure `getGenAI`, builders, parsers are exported — `parseReviewResponse`, `buildReviewPrompt`, `buildRevisePrompt`, `parseDraftResponse` already are; export `getGenAI` and `MODEL`)
- Test: `src/diffpress/articleAIStream.test.ts`

**Interfaces:**
- Consumes: `verifyJwt` (Task 1.1), `parseAIRequest` + builders from `articleAI.ts`.
- Produces: `handler` (streamified), and a pure `formatSSE(obj): string` helper for testing.

- [ ] **Step 1: Export the Gemini accessor from `articleAI.ts`**

Change `function getGenAI()` → `export function getGenAI()` and `const MODEL` → `export const MODEL` (`src/diffpress/articleAI.ts:8,12`). No other change.

- [ ] **Step 2: Write the failing test** (`src/diffpress/articleAIStream.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { formatSSE } from "./articleAIStream";

describe("formatSSE", () => {
  it("serializes an object as an SSE data frame", () => {
    expect(formatSSE({ done: true })).toBe('data: {"done":true}\n\n');
  });
});
```

- [ ] **Step 3: Run it, verify it fails**

Run: `npx vitest run src/diffpress/articleAIStream.test.ts`
Expected: FAIL — `formatSSE` not exported.

- [ ] **Step 4: Implement** (`src/diffpress/articleAIStream.ts`)

```ts
// src/diffpress/articleAIStream.ts
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { Type } from "@google/genai";
import { sanitizeMarkdown } from "../utils";
import {
  getGenAI,
  MODEL,
  parseAIRequest,
  buildReviewPrompt,
  parseReviewResponse,
  buildRevisePrompt,
} from "./articleAI";
import { verifyJwt } from "./jwtAuth";

// `awslambda` is the global injected into the Lambda Node runtime for streaming.
declare const awslambda: {
  streamifyResponse: (
    fn: (event: APIGatewayProxyEventV2, responseStream: NodeJS.WritableStream) => Promise<void>,
  ) => unknown;
  HttpResponseStream: {
    from: (stream: NodeJS.WritableStream, metadata: { statusCode: number; headers: Record<string, string> }) => NodeJS.WritableStream;
  };
};

export function formatSSE(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const NOTE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    notes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          anchorText: { type: Type.STRING },
          note: { type: Type.STRING },
          replacement: { type: Type.STRING },
        },
        required: ["anchorText", "note", "replacement"],
      },
    },
  },
  required: ["notes"],
};

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" },
  });

  const write = (obj: unknown) => stream.write(formatSSE(obj));

  try {
    await verifyJwt(event);
  } catch {
    write({ error: "Unauthorized" });
    stream.end();
    return;
  }

  // parseAIRequest expects an authorizer claim; for the Function URL we've
  // already verified the JWT, so synthesize the shape it validates against.
  const req = parseAIRequest({
    ...event,
    requestContext: { authorizer: { jwt: { claims: { sub: "verified" } } } } as any,
  });
  if (!req.ok) {
    write({ error: req.message });
    stream.end();
    return;
  }

  try {
    if (req.action === "review") {
      // Stream the model output, accumulate, then parse + emit notes as the
      // closing JSON resolves. (Gemini structured output finalizes at the end;
      // for true per-note emission, see the JSONL variant note below.)
      let buf = "";
      const result = await getGenAI().models.generateContentStream({
        model: MODEL,
        contents: [{ text: buildReviewPrompt(req.articleMarkdown) }],
        config: { responseMimeType: "application/json", responseSchema: NOTE_SCHEMA },
      });
      for await (const chunk of result) buf += chunk.text ?? "";
      for (const note of parseReviewResponse(buf)) write({ note });
      write({ done: true });
    } else if (req.action === "revise") {
      let title = "";
      const result = await getGenAI().models.generateContentStream({
        model: MODEL,
        contents: [{ text: buildRevisePrompt(req) }],
      });
      // Revise streams plain markdown; the first line is the title (`# ...`).
      let md = "";
      for await (const chunk of result) {
        const t = chunk.text ?? "";
        md += t;
        write({ chunk: t });
      }
      const firstHeading = /^#\s+(.+)$/m.exec(md);
      title = firstHeading ? firstHeading[1].trim() : "";
      write({ title, done: true });
    } else {
      write({ error: "reply is not streamed; use POST /api/articles/ai" });
    }
  } catch (err: any) {
    console.error(`[articleAIStream:${req.action}] failed:`, err);
    write({ error: "AI request failed." });
  }
  stream.end();
});
```

> DECISION — review streaming granularity: Gemini structured output (`responseSchema`) only finalizes the full JSON at the end, so the loop above accumulates then emits notes ~together. That still **fixes the timeout** (no 30s cap on the Function URL) and lets the UI reveal as they parse. For *genuinely incremental* per-note reveal, drop `responseSchema`, instruct the model to emit **one JSON object per line (JSONL, no code fences)**, and parse complete lines out of `buf` inside the `for await` loop. Start with the accumulate-then-emit version (simpler, robust); upgrade to JSONL only if the reveal feels too bursty. `// ponytail: accumulate-then-emit; switch to JSONL parse-per-line if reveal must be incremental`

- [ ] **Step 5: Run it, verify it passes**

Run: `npx vitest run src/diffpress/articleAIStream.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/articleAIStream.ts src/diffpress/articleAIStream.test.ts src/diffpress/articleAI.ts
git commit -m "feat(diffpress): streaming SSE handler for review/revise"
```

---

### Task 1.3: Wire the streaming Function in `sst.config.ts`

**Files:**
- Modify: `sst.config.ts` (add Function + Linkables + output; near the article routes ~`:435-484`)

- [ ] **Step 1: Expose user-pool id + client id as Linkables** (so `jwtAuth.ts` can read them)

After `webClient` is created (`sst.config.ts:199-209`):

```ts
const UserPoolId = new sst.Linkable("UserPoolId", { properties: { value: auth.id } });
const WebClientId = new sst.Linkable("WebClientId", { properties: { value: webClient.id } });
```

- [ ] **Step 2: Add the streaming Function with a URL**

```ts
const articleAIStream = new sst.aws.Function("DiffPressArticleAIStream", {
  handler: "src/diffpress/articleAIStream.handler",
  link: [GEMINI_API_KEY, UserPoolId, WebClientId],
  url: { cors: { allowOrigins: ["*"], allowHeaders: ["authorization", "content-type"] } },
  streaming: true,
  timeout: "120 seconds",
});
```

- [ ] **Step 3: Export the URL** (add to the stack return / outputs object, alongside `site`, `api`, etc.)

```ts
articleAIStreamUrl: articleAIStream.url,
```

- [ ] **Step 4: Pass it to the frontend build** as a public env var. The web server / Astro build reads `PUBLIC_*`. Where `PUBLIC_API_URL: api.url` is set (`sst.config.ts:507`), add:

```ts
PUBLIC_AI_STREAM_URL: articleAIStream.url,
```

- [ ] **Step 5: Type-check + deploy to a dev/staging stage**

Run: `npx sst deploy --stage dev` (or your staging stage)
Expected: deploy succeeds; `articleAIStreamUrl` printed in outputs.

> NOTE: `sst diff`/`deploy` regenerates `sst-env.d.ts` and may transiently break `tsc` for the new `Resource.UserPoolId`/`WebClientId`/env. Re-run `tsc` after deploy; cast with `(Resource as any)` only if blocked (known repo gotcha).

- [ ] **Step 6: Commit**

```bash
git add sst.config.ts
git commit -m "feat(diffpress): wire streaming AI Function URL + cognito linkables"
```

---

### Task 1.4: Frontend — `AI_STREAM_URL` constant + streaming service functions

**Files:**
- Modify: `src/lib/amplify.ts` (export `AI_STREAM_URL` from `import.meta.env.PUBLIC_AI_STREAM_URL`)
- Modify: `src/components/diffpress/services.ts`

**Interfaces:**
- Produces: `runReviewStream(repo, md, onNote)`, `reviseArticleStream(repo, md, instruction, onChunk)` (signatures in Phase 1 header).
- `reply` keeps the existing buffered `replyToNote` against `/api/articles/ai` — unchanged.

- [ ] **Step 1: Add `AI_STREAM_URL`** in `src/lib/amplify.ts`:

```ts
export const AI_STREAM_URL = import.meta.env.PUBLIC_AI_STREAM_URL as string;
```

- [ ] **Step 2: Add a shared SSE reader + the two stream services** in `services.ts`:

```ts
import { fetchAuthSession } from "aws-amplify/auth";
import { AI_STREAM_URL } from "@/lib/amplify";

/** POST to the streaming Function URL with the Cognito id token; yield parsed SSE `data:` frames. */
async function* sseStream(body: unknown): AsyncGenerator<any> {
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(AI_STREAM_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`AI stream failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const frames = buf.split("\n\n");
    buf = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.replace(/^data:\s*/, "").trim();
      if (line) yield JSON.parse(line);
    }
  }
}

export async function runReviewStream(
  repo: string,
  articleMarkdown: string,
  onNote: (n: ReviewNote) => void,
): Promise<void> {
  for await (const msg of sseStream({ action: "review", repo, articleMarkdown })) {
    if (msg.error) throw new Error(msg.error);
    if (msg.note) onNote(msg.note);
    if (msg.done) return;
  }
}

export async function reviseArticleStream(
  repo: string,
  articleMarkdown: string,
  instruction: string,
  onChunk: (md: string) => void,
): Promise<{ title: string }> {
  let title = "";
  for await (const msg of sseStream({ action: "revise", repo, articleMarkdown, instruction })) {
    if (msg.error) throw new Error(msg.error);
    if (msg.chunk) onChunk(msg.chunk);
    if (msg.done) title = msg.title ?? "";
  }
  return { title };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/amplify.ts src/components/diffpress/services.ts
git commit -m "feat(diffpress): streaming review/revise service functions"
```

---

### Task 1.5: Store — consume the streams, delete the fake reveal

**Files:**
- Modify: `src/components/diffpress/store.ts` (`runReview` ~`:411-434`, `reviseArticle` ~`:476-495`)
- Modify: `src/components/diffpress/store.test.ts` (update/extend existing review tests)

**Interfaces:**
- Consumes: `runReviewStream`, `reviseArticleStream`.
- `revealedNoteIds` semantics change: a note is "revealed" the moment it arrives, so push its id when `onNote` fires. Remove `revealTimers` and the `setTimeout` block entirely.

- [ ] **Step 1: Update the failing test first** in `store.test.ts` — mock `runReviewStream` to invoke `onNote` twice, assert `notes.length === 2` and both ids are in `revealedNoteIds` after `await runReview()`. (Mirror the existing review test; replace the `runReviewApi` mock with `runReviewStream`.)

```ts
// sketch — adapt to the file's existing mock style
vi.mock("./services", async (orig) => ({
  ...(await orig<typeof import("./services")>()),
  runReviewStream: vi.fn(async (_r, _m, onNote) => {
    onNote({ id: "n1", anchorText: "a", note: "x", replacement: "b" });
    onNote({ id: "n2", anchorText: "c", note: "y", replacement: "d" });
  }),
}));
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx vitest run src/components/diffpress/store.test.ts`
Expected: FAIL — store still calls `runReviewApi`.

- [ ] **Step 3: Rewrite `runReview`** (replace `:411-434`):

```ts
runReview: async () => {
  const { articleRepo, articleMarkdown } = get();
  if (!articleRepo) return;
  set({ reviewing: true, notes: [], revealedNoteIds: [], resolvedNotes: {}, chat: {}, openNote: null });
  try {
    await runReviewStream(articleRepo, articleMarkdown, (note) => {
      if (get().articleRepo !== articleRepo) return;
      set((s) => ({ notes: [...s.notes, note], revealedNoteIds: [...s.revealedNoteIds, note.id] }));
    });
    if (get().articleRepo === articleRepo) set({ reviewing: false });
  } catch (err) {
    console.warn("[diffpress] review failed:", err);
    set({ reviewing: false, reviewError: err instanceof Error ? err.message : "Review failed" });
  }
},
```

Add `reviewError: string | null` to the interface + initial state (`null`); clear it to `null` when starting a review. (See Task 2.x / Phase 1 surfacing — the UI must show this instead of failing silently.) Delete the `let revealTimers` declaration (`:47`) and its `forEach(clearTimeout)` usages.

- [ ] **Step 4: Rewrite `reviseArticle`** (replace `:476-495`):

```ts
reviseArticle: async (instruction) => {
  const { articleRepo, articleMarkdown } = get();
  if (!articleRepo || !instruction.trim()) return;
  set({ revising: true });
  try {
    let md = "";
    const { title } = await reviseArticleStream(articleRepo, articleMarkdown, instruction, (chunk) => {
      md += chunk;
    });
    if (get().articleRepo !== articleRepo) return;
    set((s) => ({
      articleMarkdown: md,
      articleTitle: title || s.articleTitle,
      articleSaved: false,
      articleSeed: s.articleSeed + 1,
      revising: false,
    }));
    await get().saveArticle();
  } catch (err) {
    console.warn("[diffpress] revise failed:", err);
    set({ revising: false });
  }
},
```

> NOTE: for revise we accumulate the streamed markdown then re-seed once (`articleSeed + 1`) rather than live-typing into the contentEditable — simplest correct behavior. Live token-by-token rendering into the editor is a YAGNI upgrade. `// ponytail: accumulate then re-seed; live-render only if the streaming-into-editor effect is wanted`

- [ ] **Step 5: Run tests + type-check**

Run: `npx vitest run src/components/diffpress/store.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/diffpress/store.ts src/components/diffpress/store.test.ts
git commit -m "feat(diffpress): consume AI streams in store, drop faked reveal"
```

---

### Task 1.6: Surface review errors in the UI (no more silent failure)

**Files:**
- Modify: `src/components/diffpress/ReviewArticle.tsx` (`ReviewBanner`, ~`:87-120`)

- [ ] **Step 1:** Read `reviewError` in `ReviewBanner` and render it when set:

```tsx
const reviewError = useDiffPress((s) => s.reviewError);
// ...after the `reviewing` branch:
if (reviewError) {
  return (
    <div className="mb-7 text-[12.5px] text-dp-add-ink">
      Review failed: {reviewError}. Try again.
    </div>
  );
}
```

(Use an existing red-ish token; `dp-add-ink` is green — pick or add a quiet error token consistent with the palette.)

- [ ] **Step 2: Manual verify** against the deployed dev stage (see Task 1.7). A forced error (e.g. bad token) shows the message instead of a blank panel.

- [ ] **Step 3: Commit**

```bash
git add src/components/diffpress/ReviewArticle.tsx
git commit -m "feat(diffpress): surface review errors instead of failing silently"
```

---

### Task 1.7: End-to-end verification + retire/keep the old route

**Files:**
- Modify: `sst.config.ts` (optional: keep `POST /api/articles/ai` for `reply` only)

- [ ] **Step 1:** Deploy dev stage; open the HoldSpeak article (the real long one that reproduced the 503).
- [ ] **Step 2:** Click Run AI review. **Expected:** notes appear within ~30-60s with NO 503 (verify in the Network tab the request is to the Function URL, status 200, `text/event-stream`).
- [ ] **Step 3:** Run a revise instruction. **Expected:** article updates, no 503.
- [ ] **Step 4:** Confirm `reply` (pushback on a note) still works via the buffered `/api/articles/ai` route. Keep that route; it's short and within 30s.
- [ ] **Step 5:** Commit any config change; then promote to prod when satisfied.

**Done when:** review and revise complete on the real article with zero 503s, and the network call is the streaming Function URL.

---

## Phase 2 — Editor redesign (declutter)

Pure frontend. Implements the four design moves: (1) autosave status replaces the Save button and is the entry to history; (2) version history moves into a right-side drawer reusing the `HandoffDrawer` pattern; (3) one docked AI revise bar pinned at the bottom; (4) drop the standalone "Run AI review" button (Review is already a top-nav mode in `TopBar`).

### File Structure

- **Create** `src/components/diffpress/VersionHistoryDrawer.tsx` — right-side drawer (clone of `HandoffDrawer.tsx` structure) listing `drafts` with relative + exact timestamps and per-version Restore.
- **Modify** `src/components/diffpress/store.ts` — add `historyOpen: boolean`, `openHistory()`, `closeHistory()`; add a `lastSavedAt: number | null` timestamp set on successful save/autosave.
- **Modify** `src/components/diffpress/DraftEditor.tsx` — remove the Save button + the old inline "Version history" list + the standalone "Run AI review" button; add the quiet autosave status line; pin the revise bar to the bottom.
- **Modify** `src/components/diffpress/DiffPress.tsx` — mount `<VersionHistoryDrawer />` alongside `<HandoffDrawer />`.

### Task 2.1: Autosave status line (replaces Save button) + `lastSavedAt`

**Files:**
- Modify: `store.ts` (`saveArticle` ~`:238-250`; add `lastSavedAt`)
- Modify: `DraftEditor.tsx` (`:315-338` controls block)

- [ ] **Step 1:** In `store.ts` add `lastSavedAt: number | null` (init `null`); in `saveArticle` success branch set `lastSavedAt: Date.now()` alongside `articleSaved: true`.
- [ ] **Step 2:** In `DraftEditor.tsx` replace the Save-button block (`:316-330`) with a quiet status that reads `saving`/`saved`/`lastSavedAt` and is a button that calls `openHistory`:

```tsx
<button
  onClick={openHistory}
  className="flex items-center gap-2 border-none bg-transparent p-0 text-[12.5px] text-dp-faint-2 hover:text-dp-muted"
>
  <span className={cn("h-[6px] w-[6px] rounded-full", saving ? "dp-pulse bg-dp-slate" : "bg-dp-green")} />
  {saving ? "Saving…" : lastSavedAt ? `Saved · ${new Date(lastSavedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not saved yet"}
  <History size={13} strokeWidth={1.7} />
</button>
```

(Import `History` from `lucide-react`; wire `openHistory`, `lastSavedAt`.)

- [ ] **Step 3:** Type-check + manual: typing flips to "Saving…" then "Saved · <time>".
- [ ] **Step 4:** Commit.

### Task 2.2: Version history drawer

**Files:**
- Create: `VersionHistoryDrawer.tsx`
- Modify: `store.ts` (`historyOpen`, `openHistory`, `closeHistory`)
- Modify: `DiffPress.tsx` (mount it)
- Modify: `DraftEditor.tsx` (delete the old inline history list `:367-388`)

- [ ] **Step 1:** Add `historyOpen` state + `openHistory: () => set({ historyOpen: true })` + `closeHistory`.
- [ ] **Step 2:** Create `VersionHistoryDrawer.tsx` — copy `HandoffDrawer`'s overlay+aside shell (`HandoffDrawer.tsx:25-31`), header "VERSION HISTORY" + article title, close button, and a timeline of `drafts`:
  - First entry: "Current draft" with a filled dot.
  - Each draft: relative time (e.g. "10 min ago") + exact `toLocaleTimeString`, change summary if present, `Restore` button calling `restoreDraft(d.ts)`.
  - AI-driven edits get a filled dot (others hollow) — requires a `source?: "ai" | "user"` flag on `DraftMeta`; if not available from the backend, **skip the dot distinction** (YAGNI) until the draft record carries it. `// ponytail: hollow dots only until DraftMeta carries an ai/user flag`
- [ ] **Step 3:** Render `{historyOpen && <VersionHistoryDrawer />}` (or null-guard inside) in `DiffPress.tsx` next to `<HandoffDrawer />`.
- [ ] **Step 4:** Delete the inline history block in `DraftEditor.tsx` (`:367-388`).
- [ ] **Step 5:** Type-check + build + manual: status line opens the drawer; Restore re-seeds the editor (existing `restoreDraft` already bumps `articleSeed`).
- [ ] **Step 6:** Commit.

### Task 2.3: Single docked revise bar + drop "Run AI review"

**Files:**
- Modify: `DraftEditor.tsx` (revise box `:340-365`, controls `:315-338`, callbacks `:125-142`)

- [ ] **Step 1:** Delete the standalone "Run AI review" button (`:331-337`) and the now-unused `onRunReview`/`runReview`/`setEditorMode` wiring **only if** nothing else uses them in this component. (Review is reached via the top-nav `Review` tab. NOTE: the `Review` tab in `TopBar` only calls `setEditorMode("review")` — it does **not** trigger `runReview`. Decide: either (a) auto-run review when entering review mode with no notes, or (b) add a quiet "Run review" text action inside the revise bar. **Recommend (b)** — keep the trigger explicit; the user offered this in the design. Add it as a small text button in the docked bar.)
- [ ] **Step 2:** Restyle the revise box (`:340-365`) into a docked bar: `fixed inset-x-0 bottom-0` (or absolutely positioned within the editor column), centered to the editor max-width, calm by default, lifts/deepens shadow on focus. Enter or the arrow submits (`onRevise`). Match the design screenshot (rounded, `+`/sparkle affordance, arrow submit).
- [ ] **Step 3:** Build + manual: bar stays pinned at the bottom while scrolling; focus lifts it; Enter revises.
- [ ] **Step 4:** Commit.

> If you pick option (a) auto-run-on-enter-review: in `TopBar` `Review` onClick, call a store action that does `setEditorMode("review")` then `if (!notes.length) runReview()`. Keep the explicit text action regardless so a re-run is possible.

---

## Phase 3 — Editable / clickable links in the editor

Pure frontend. Links already persist (Turndown serializes `<a href>` → `[text](url)`, marked reverses it — verified). The gap: the selection-toolbar link button (`DraftEditor.tsx:171-174,485`) always creates a *fresh* link via `window.prompt("Link URL", "https://")`; there's no way to see/edit/remove an existing link.

### Task 3.1: Edit/remove existing links from the selection toolbar

**Files:**
- Modify: `src/components/diffpress/DraftEditor.tsx` (`doLink` `:171-174`; the link `SelBtn` `:485`)

- [ ] **Step 1:** Replace `doLink` so it detects an existing anchor at the selection and pre-fills/updates/removes it:

```tsx
const currentAnchor = useCallback((): HTMLAnchorElement | null => {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  let n: Node | null = sel.getRangeAt(0).startContainer;
  while (n && n !== proseRef.current) {
    if (n.nodeType === 1 && (n as HTMLElement).tagName === "A") return n as HTMLAnchorElement;
    n = n.parentNode;
  }
  return null;
}, []);

const doLink = () => {
  const existing = currentAnchor();
  const current = existing?.getAttribute("href") ?? "https://";
  const u = window.prompt("Link URL (empty to remove)", current);
  if (u === null) return;          // cancelled
  if (u.trim() === "" && existing) { exec("unlink"); return; }
  if (existing) {
    // Re-select the whole anchor so createLink replaces its href cleanly.
    const r = document.createRange();
    r.selectNode(existing);
    const s = window.getSelection();
    s?.removeAllRanges();
    s?.addRange(r);
  }
  if (u.trim()) exec("createLink", u.trim());
};
```

> NOTE: `window.prompt` is the existing pattern in this file (image/link insert). Keeping it is the lazy-correct choice — a custom inline link popover is a nicer-but-bigger change; do that only if the prompt feels out of place with the redesign. `// ponytail: reuse window.prompt like image insert; build an inline popover only if the dialog clashes with the new design`

- [ ] **Step 2:** (Optional, recommended) Make links visually obvious and verifiable in the editor: ensure `.dp-prose a` is styled (underline + slate color) and add `title={href}` behavior — simplest is a CSS rule so the URL shows in the native tooltip via the existing `href`. Confirm the prose stylesheet already styles anchors; if not, add a rule in the DiffPress CSS.
- [ ] **Step 3:** Manual verify: create a link, re-select it, click the link button → prompt shows the existing URL → edit it → href updates; clear the URL → link removed; save → reopen → link persists with the new URL.
- [ ] **Step 4:** Commit.

> Clicking a link to *navigate* inside a contentEditable is intentionally not wired (clicking positions the cursor for editing). If you want click-through, add a Cmd/Ctrl+click handler on the prose that opens `a.href` in a new tab — small, optional.

---

## Self-Review notes

- **Spec coverage:** Phase 1 → AI review bug (root-caused: 30s HTTP API cap; fixed via streaming Function URL). Phase 2 → all four redesign moves (autosave status, history drawer, docked revise bar, drop Run-AI-review button) + the explicit-trigger decision. Phase 3 → editable/clickable links.
- **Auth:** `verifyJwt` uses id-token verification matching `authedFetch` (sends `idToken`) and the gateway authorizer (`tokenUse:"id"` audience = `webClient.id`).
- **Known gotchas carried in:** SST type-gen clobbers `sst-env.d.ts` (cast `Resource as any` transiently); vitest `mockReset`/`beforeEach` block-body rule when adding mocks.
- **Open decision for the implementer:** review streaming granularity (accumulate-then-emit vs JSONL) and revise rendering (re-seed vs live) — both default to the simpler option with a documented upgrade path.
