# In-UI Webhook Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two hardcoded webhook targets (`diffpress`/`thephilgray`) and the static `PUBLISH_WEBHOOKS` secret with user-managed, persisted webhook configs editable from the DiffPress publish console — secrets in SSM, metadata in DynamoDB, plus a "test connection" path.

**Architecture:** Webhook metadata `{id,name,url,createdAt}` lives in a new `WebhookConfig` Dynamo table; each secret is an SSM `SecureString` at `/diffpress/<stage>/webhooks/<id>` (param name derived from id — nothing secret in the DB). Pure helpers (target model, canonical-from-URL, param name, input validation) carry the unit tests; the CRUD handler, publish path, and frontend are thin glue around them.

**Tech Stack:** SST v3 (Lambda, DynamoDB, SSM), TypeScript, Node 20 `crypto`, `@aws-sdk/client-ssm` (new) + `@aws-sdk/lib-dynamodb`, Vitest, React + Zustand frontend.

## Global Constraints

- Secrets live ONLY in SSM `SecureString`. Never stored in DynamoDB, never returned by any GET response.
- SSM parameter name is derived, not stored: `/diffpress/<stage>/webhooks/<id>`. Stage from `process.env.SST_STAGE`.
- Webhook delivery is hardcoded `POST` + JSON + header `X-DiffPress-Signature: sha256=<hex HMAC-SHA256(rawBody, secret)>`. No configurable method/format/headers.
- All `/api/webhooks*` routes use the existing JWT `authorizer`, matching every other `/api/*` route.
- SST type-gen gotcha: new resources are not in `sst-env.d.ts` until `sst dev`/`sst deploy` regenerates it. Read resource names through a cast (`Resource as unknown as { WebhookConfig: { name: string } }`), exactly like `src/diffpress/lib/ledger.ts:18`.
- Canonical URL rule: origin of the FIRST enabled webhook's URL; none enabled → empty string (Dev.to gets no `canonical_url`).
- Test command: `npx vitest run <path>`. Typecheck: `npx tsc --noEmit`.

---

### Task 1: Target model + canonical helper (`lib/publish.ts`)

Rework the pure target model: drop the hardcoded `diffpress`/`thephilgray` from `PublishTargets`, add a dynamic `webhooks: string[]`, widen result ids to `string`, and replace `canonicalUrlFor`/`DOMAIN_BASE` with a URL-derived helper.

**Files:**
- Modify: `src/diffpress/lib/publish.ts`
- Test: `src/diffpress/lib/publish.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `interface PublishTargets { devto: boolean; linkedin: boolean; substack: boolean; webhooks: string[] }`
  - `interface TargetResult { id: string; ok: boolean; detail: string }`
  - `function selectedTargets(t: PublishTargets): string[]` — enabled fixed ids followed by `t.webhooks`
  - `function canonicalUrlFromWebhook(firstWebhookUrl: string | null, slug: string): string`
  - `function buildWebhookPayload(args: { title; markdown; repoName; seriesLink; canonicalUrl: string; publishedAt }): WebhookPayload` (now takes `canonicalUrl`, no longer `targets`)
  - `parsePublishInput` accepts `targets.webhooks: string[]`

- [ ] **Step 1: Write the failing tests**

Add to `src/diffpress/lib/publish.test.ts`:

```ts
import { canonicalUrlFromWebhook, selectedTargets, parsePublishInput } from "./publish";

describe("canonicalUrlFromWebhook", () => {
  it("derives origin from the first webhook url + slug", () => {
    expect(canonicalUrlFromWebhook("https://diffpress.com/x/y", "my-post")).toBe(
      "https://diffpress.com/my-post"
    );
  });
  it("returns empty string when no webhook url", () => {
    expect(canonicalUrlFromWebhook(null, "my-post")).toBe("");
  });
});

describe("selectedTargets (with dynamic webhooks)", () => {
  it("returns enabled fixed targets followed by webhook ids", () => {
    expect(
      selectedTargets({ devto: true, linkedin: false, substack: false, webhooks: ["wh_a", "wh_b"] })
    ).toEqual(["devto", "wh_a", "wh_b"]);
  });
});

describe("parsePublishInput webhooks", () => {
  const base = { requestContext: { authorizer: { jwt: { claims: { sub: "u1" } } } } };
  it("accepts a webhooks string array and rejects non-strings", () => {
    const ev = {
      ...base,
      body: JSON.stringify({
        repoName: "o/r",
        targets: { devto: false, webhooks: ["wh_a", 5, "wh_b"] },
        timing: "now",
      }),
    };
    const r = parsePublishInput(ev as any);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.targets.webhooks).toEqual(["wh_a", "wh_b"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/diffpress/lib/publish.test.ts`
Expected: FAIL — `canonicalUrlFromWebhook` is not exported; `selectedTargets`/`parsePublishInput` reject the new shape.

- [ ] **Step 3: Update the model in `lib/publish.ts`**

Replace the `TargetId` type and `PublishTargets` interface (lines ~3–11):

```ts
// Fixed (non-webhook) syndication targets. Webhooks are dynamic, by id.
export type FixedTargetId = "devto" | "linkedin" | "substack";

export interface PublishTargets {
  devto: boolean;
  linkedin: boolean;
  substack: boolean;
  webhooks: string[]; // enabled webhook config ids
}
```

Change `TargetResult.id` to `string`:

```ts
export interface TargetResult {
  id: string;
  ok: boolean;
  detail: string;
}
```

Replace `TARGET_NAMES` (keyed by the old union) with a fixed-only map and make `summarizeResults` fall back to the id:

```ts
const TARGET_NAMES: Record<string, string> = {
  devto: "Dev.to",
  linkedin: "LinkedIn",
  substack: "Substack",
};
```

In `summarizeResults`, change `TARGET_NAMES[r.id]` to `(TARGET_NAMES[r.id] ?? r.id)`.

Delete the `DOMAIN_BASE` constant (lines ~49–53) and the entire `canonicalUrlFor` function (lines ~66–70). Add:

```ts
/** Canonical base = origin of the first enabled webhook's URL; empty when none. */
export function canonicalUrlFromWebhook(firstWebhookUrl: string | null, slug: string): string {
  if (!firstWebhookUrl) return "";
  return `${new URL(firstWebhookUrl).origin}/${slug}`;
}
```

Change `buildWebhookPayload` to take `canonicalUrl` instead of `targets`:

```ts
export function buildWebhookPayload(args: {
  title: string;
  markdown: string;
  repoName: string;
  seriesLink: string;
  canonicalUrl: string;
  publishedAt: string;
}): WebhookPayload {
  const slug = slugify(args.title);
  return {
    title: args.title,
    slug,
    markdown: args.markdown,
    canonicalUrl: args.canonicalUrl,
    publishedAt: args.publishedAt,
    series: args.seriesLink.trim() === "" ? null : args.seriesLink,
    repoName: args.repoName,
  };
}
```

Replace `selectedTargets` (lines ~136–138):

```ts
export function selectedTargets(t: PublishTargets): string[] {
  const fixed = (["devto", "linkedin", "substack"] as const).filter((k) => t[k]);
  return [...fixed, ...t.webhooks];
}
```

In `parsePublishInput`, replace the `norm` construction (lines ~168–174) with:

```ts
  const norm: PublishTargets = {
    devto: !!targets.devto,
    linkedin: !!targets.linkedin,
    substack: !!targets.substack,
    webhooks: Array.isArray(targets.webhooks)
      ? targets.webhooks.filter((x: unknown): x is string => typeof x === "string")
      : [],
  };
```

- [ ] **Step 4: Fix existing tests that reference the old shape**

In `src/diffpress/lib/publish.test.ts`, update any existing `buildWebhookPayload` / `PublishTargets` / `canonicalUrlFor` usages: pass `canonicalUrl` to `buildWebhookPayload` directly, and replace `{ diffpress, thephilgray }` target literals with `{ devto, linkedin, substack, webhooks }`. Remove the old `canonicalUrlFor` describe block.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/diffpress/lib/publish.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/diffpress/lib/publish.ts src/diffpress/lib/publish.test.ts
git commit -m "feat(diffpress): dynamic webhook target model + URL-derived canonical"
```

---

### Task 2: Webhook data layer (`lib/webhooks.ts`)

A focused module for the Dynamo + SSM I/O, with the pure parts (param name, id slug, input validation) unit-tested. New dependency: `@aws-sdk/client-ssm`.

**Files:**
- Create: `src/diffpress/lib/webhooks.ts`
- Test: `src/diffpress/lib/webhooks.test.ts`
- Modify: `package.json` (add `@aws-sdk/client-ssm`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `interface WebhookConfig { id: string; name: string; url: string; createdAt: string }`
  - `function paramName(stage: string, id: string): string`
  - `function slugId(name: string): string` — `wh_<slug>_<6hex>`
  - `function validateWebhookInput(body: any): { ok: true; value: { id?: string; name: string; url: string; secret?: string } } | { ok: false; message: string }`
  - `async function listWebhooks(): Promise<WebhookConfig[]>`
  - `async function upsertWebhook(input): Promise<WebhookConfig>` (Dynamo put + SSM put when secret present)
  - `async function deleteWebhook(id: string): Promise<void>` (Dynamo delete + SSM delete)
  - `async function getWebhookSecret(id: string): Promise<string | null>` (SSM get, decrypted)

- [ ] **Step 1: Add the SSM SDK dependency**

Run: `npm install @aws-sdk/client-ssm@^3.974.0`
Expected: adds to `dependencies`, no errors.

- [ ] **Step 2: Write the failing tests**

Create `src/diffpress/lib/webhooks.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { paramName, slugId, validateWebhookInput } from "./webhooks";

describe("paramName", () => {
  it("builds a stage-scoped SSM path from id", () => {
    expect(paramName("prod", "wh_abc")).toBe("/diffpress/prod/webhooks/wh_abc");
  });
});

describe("slugId", () => {
  it("produces wh_<slug>_<6hex>", () => {
    const id = slugId("My Site!");
    expect(id).toMatch(/^wh_my-site_[0-9a-f]{6}$/);
  });
});

describe("validateWebhookInput", () => {
  it("requires a non-empty name and a valid http(s) url", () => {
    expect(validateWebhookInput({ name: "", url: "https://x.com" }).ok).toBe(false);
    expect(validateWebhookInput({ name: "X", url: "ftp://x" }).ok).toBe(false);
    const ok = validateWebhookInput({ name: "X", url: "https://x.com", secret: "s" });
    expect(ok.ok).toBe(true);
  });
  it("requires a secret on create (no id) but allows blank on edit (with id)", () => {
    expect(validateWebhookInput({ name: "X", url: "https://x.com" }).ok).toBe(false);
    expect(validateWebhookInput({ id: "wh_a", name: "X", url: "https://x.com" }).ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/diffpress/lib/webhooks.test.ts`
Expected: FAIL — module `./webhooks` not found.

- [ ] **Step 4: Implement `lib/webhooks.ts`**

```ts
import { randomBytes } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  SSMClient,
  GetParameterCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  ParameterNotFound,
} from "@aws-sdk/client-ssm";
import { Resource } from "sst";

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  createdAt: string;
}

function tableName(): string {
  return (Resource as unknown as { WebhookConfig: { name: string } }).WebhookConfig.name;
}

function stage(): string {
  return process.env.SST_STAGE ?? "dev";
}

export function paramName(s: string, id: string): string {
  return `/diffpress/${s}/webhooks/${id}`;
}

export function slugId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
  return `wh_${slug}_${randomBytes(3).toString("hex")}`;
}

export function validateWebhookInput(
  body: any
): { ok: true; value: { id?: string; name: string; url: string; secret?: string } } | { ok: false; message: string } {
  const { id, name, url, secret } = body ?? {};
  if (typeof name !== "string" || name.trim() === "") return { ok: false, message: "name is required" };
  if (typeof url !== "string" || !/^https?:\/\//.test(url)) return { ok: false, message: "url must be http(s)" };
  if (!id && (typeof secret !== "string" || secret.trim() === "")) {
    return { ok: false, message: "secret is required on create" };
  }
  return { ok: true, value: { id, name: name.trim(), url: url.trim(), secret } };
}

export async function listWebhooks(): Promise<WebhookConfig[]> {
  const out = await doc.send(new ScanCommand({ TableName: tableName() }));
  return (out.Items as WebhookConfig[] | undefined ?? []).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
}

export async function upsertWebhook(input: {
  id?: string;
  name: string;
  url: string;
  secret?: string;
}): Promise<WebhookConfig> {
  const isNew = !input.id;
  const id = input.id ?? slugId(input.name);
  // Preserve createdAt on edit by reading the existing item ordering is not needed;
  // a fresh createdAt only on create keeps stable ordering.
  const item: WebhookConfig = {
    id,
    name: input.name,
    url: input.url,
    createdAt: isNew ? new Date().toISOString() : (await getCreatedAt(id)) ?? new Date().toISOString(),
  };
  await doc.send(new PutCommand({ TableName: tableName(), Item: item }));
  if (input.secret && input.secret.trim() !== "") {
    await ssm.send(
      new PutParameterCommand({
        Name: paramName(stage(), id),
        Value: input.secret,
        Type: "SecureString",
        Overwrite: true,
      })
    );
  }
  return item;
}

async function getCreatedAt(id: string): Promise<string | null> {
  const all = await listWebhooks();
  return all.find((w) => w.id === id)?.createdAt ?? null;
}

export async function deleteWebhook(id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: tableName(), Key: { id } }));
  try {
    await ssm.send(new DeleteParameterCommand({ Name: paramName(stage(), id) }));
  } catch (e) {
    if (!(e instanceof ParameterNotFound)) throw e;
  }
}

export async function getWebhookSecret(id: string): Promise<string | null> {
  try {
    const out = await ssm.send(
      new GetParameterCommand({ Name: paramName(stage(), id), WithDecryption: true })
    );
    return out.Parameter?.Value ?? null;
  } catch (e) {
    if (e instanceof ParameterNotFound) return null;
    throw e;
  }
}
```

> ponytail: `getCreatedAt` re-scans to preserve ordering on edit. Fine at single-digit webhook counts; swap for a `GetCommand` if the table ever grows.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/diffpress/lib/webhooks.test.ts`
Expected: PASS (pure helpers; Dynamo/SSM functions are untested glue).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/diffpress/lib/webhooks.ts src/diffpress/lib/webhooks.test.ts
git commit -m "feat(diffpress): webhook data layer (Dynamo metadata + SSM SecureString)"
```

---

### Task 3: CRUD + test-connection handler (`webhookConfig.ts`)

A single handler routing on method/path: list, upsert, delete, and a signed test-ping. Thin glue over Task 2.

**Files:**
- Create: `src/diffpress/webhookConfig.ts`

**Interfaces:**
- Consumes: `listWebhooks`, `upsertWebhook`, `deleteWebhook`, `getWebhookSecret`, `validateWebhookInput`, `WebhookConfig` (Task 2); `signWebhook` (`lib/publish.ts`).
- Produces: `handler(event)` mapped to `GET/POST/DELETE /api/webhooks` and `POST /api/webhooks/test`.

- [ ] **Step 1: Implement the handler**

```ts
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { signWebhook } from "./lib/publish";
import {
  listWebhooks,
  upsertWebhook,
  deleteWebhook,
  getWebhookSecret,
  validateWebhookInput,
} from "./lib/webhooks";

const json = (statusCode: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export async function handler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.requestContext.http.path;

  try {
    if (path.endsWith("/api/webhooks/test") && method === "POST") {
      return await handleTest(event);
    }
    if (method === "GET") {
      const items = await listWebhooks(); // {id,name,url,createdAt} — no secret stored, none to leak
      return json(200, { webhooks: items.map(({ id, name, url }) => ({ id, name, url })) });
    }
    if (method === "POST") {
      const parsed = validateWebhookInput(safeJson(event.body));
      if (!parsed.ok) return json(400, { message: parsed.message });
      const saved = await upsertWebhook(parsed.value);
      return json(200, { webhook: { id: saved.id, name: saved.name, url: saved.url } });
    }
    if (method === "DELETE") {
      const id = event.queryStringParameters?.id;
      if (!id) return json(400, { message: "id is required" });
      await deleteWebhook(id);
      return json(200, { deleted: true });
    }
    return json(405, { message: "Method not allowed" });
  } catch (err: any) {
    console.error("[webhookConfig] failed:", err);
    return json(500, { message: "Webhook config operation failed" });
  }
}

async function handleTest(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const body = safeJson(event.body) ?? {};
  let url: string | undefined = body.url;
  let secret: string | undefined = body.secret;
  if (body.id && (!secret || secret.trim() === "")) {
    secret = (await getWebhookSecret(body.id)) ?? undefined;
    if (!url) {
      const cfg = (await listWebhooks()).find((w) => w.id === body.id);
      url = cfg?.url;
    }
  }
  if (!url || !secret) return json(400, { message: "url and secret (or a saved id) are required" });

  const rawBody = JSON.stringify({ test: true });
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DiffPress-Signature": signWebhook(rawBody, secret),
      },
      body: rawBody,
    });
    return json(200, { ok: res.ok, status: res.status });
  } catch (err: any) {
    return json(200, { ok: false, status: 0, detail: err?.message ?? "request failed" });
  }
}

function safeJson(body: string | null | undefined): any {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS (the `Resource.WebhookConfig` cast in `lib/webhooks.ts` avoids the missing-type error until deploy regenerates `sst-env.d.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/diffpress/webhookConfig.ts
git commit -m "feat(diffpress): webhook CRUD + test-connection handler"
```

---

### Task 4: SST wiring — table, routes, permissions (`sst.config.ts`)

Declare the table, mount the routes, grant SSM permissions, and rewire the publish routes off the retired secret.

**Files:**
- Modify: `sst.config.ts`

**Interfaces:**
- Consumes: `webhookConfig.handler` (Task 3); `publishArticle.handler` / `publishScheduled.handler` (existing).
- Produces: `WebhookConfig` Dynamo resource; `/api/webhooks*` routes; SSM permissions on three handlers.

- [ ] **Step 1: Declare the table**

Near the other DiffPress Dynamo declarations (after `publicationLifecycle`, ~line 375), add:

```ts
    // Webhook syndication configs (PK: id). Metadata only — secrets live in
    // SSM SecureString at /diffpress/<stage>/webhooks/<id>.
    const webhookConfig = new sst.aws.Dynamo("WebhookConfig", {
      fields: { id: "string" },
      primaryIndex: { hashKey: "id" },
    });
```

- [ ] **Step 2: Add the CRUD + test routes**

After the `POST /api/publish` route block (~line 422), add (each `<METHOD> /api/webhooks` shares the handler; the SSM ARN uses the stage):

```ts
    const ssmWebhookArn = $interpolate`arn:aws:ssm:*:*:parameter/diffpress/${$app.stage}/webhooks/*`;

    for (const route of ["GET /api/webhooks", "POST /api/webhooks", "DELETE /api/webhooks", "POST /api/webhooks/test"]) {
      api.route(route, {
        handler: "src/diffpress/webhookConfig.handler",
        link: [auth, webhookConfig],
        permissions: [
          { actions: ["ssm:GetParameter", "ssm:PutParameter", "ssm:DeleteParameter"], resources: [ssmWebhookArn] },
        ],
        timeout: "30 seconds",
      }, {
        auth: { jwt: { authorizer: authorizer.id } },
      });
    }
```

- [ ] **Step 3: Rewire the publish + cron handlers**

On the `POST /api/publish` route (~line 412): remove `PUBLISH_WEBHOOKS` from `link`, add `webhookConfig`, and add an SSM read permission:

```ts
    api.route("POST /api/publish", {
      handler: "src/diffpress/publishArticle.handler",
      link: [auth, publicationLifecycle, DEVTO_API_KEY, webhookConfig],
      permissions: [
        { actions: ["ssm:GetParameter"], resources: [$interpolate`arn:aws:ssm:*:*:parameter/diffpress/${$app.stage}/webhooks/*`] },
      ],
      timeout: "30 seconds",
    }, {
      auth: { jwt: { authorizer: authorizer.id } },
    });
```

On the `PublishScheduledCron` (~line 695): replace `PUBLISH_WEBHOOKS` with `webhookConfig` in `link`, and add the same `permissions` array (Cron function blocks accept `permissions`).

- [ ] **Step 4: Retire the secret declaration**

Delete `const PUBLISH_WEBHOOKS = new sst.Secret("PUBLISH_WEBHOOKS");` (~line 22). Confirm no remaining references:

Run: `grep -rn "PUBLISH_WEBHOOKS" sst.config.ts src/`
Expected: no matches.

- [ ] **Step 5: Typecheck the config**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sst.config.ts
git commit -m "feat(diffpress): WebhookConfig table, CRUD routes, SSM permissions; retire PUBLISH_WEBHOOKS"
```

---

### Task 5: Rewire publish fan-out to DB + SSM (`publishArticle.ts`, `publishScheduled.ts`)

Replace the `PUBLISH_WEBHOOKS` secret read and the two-target switch with the dynamic data layer and URL-derived canonical.

**Files:**
- Modify: `src/diffpress/publishArticle.ts`
- Verify: `src/diffpress/publishScheduled.ts` (it imports `publishNow`; confirm no local target literals)
- Test: `src/diffpress/lib/ledger.scheduled.test.ts` and `src/diffpress/lib/publish.test.ts` still pass

**Interfaces:**
- Consumes: `listWebhooks`, `getWebhookSecret`, `WebhookConfig` (Task 2); `canonicalUrlFromWebhook`, `selectedTargets`, `buildWebhookPayload`, `signWebhook` (Task 1).
- Produces: `publishNow` unchanged signature; webhook delivery now generic over ids.

- [ ] **Step 1: Replace the secret reader and webhook poster**

In `src/diffpress/publishArticle.ts`, delete the `WebhookConfig` interface and `webhookConfigs()` (lines ~19–30) and the `import { Resource } from "sst"` if now unused. Add:

```ts
import { listWebhooks, getWebhookSecret, type WebhookConfig } from "./lib/webhooks";
import { canonicalUrlFromWebhook } from "./lib/publish";
```

Replace `postWebhook` (lines ~56–90) with a version taking a resolved config + secret + canonicalUrl:

```ts
async function postWebhook(
  cfg: WebhookConfig,
  secret: string,
  record: PublicationRecord,
  seriesLink: string,
  canonicalUrl: string
): Promise<TargetResult> {
  try {
    const rawBody = JSON.stringify(
      buildWebhookPayload({
        title: record.title ?? "",
        markdown: record.articleMarkdown ?? "",
        repoName: record.repoName,
        seriesLink,
        canonicalUrl,
        publishedAt: new Date().toISOString(),
      })
    );
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-DiffPress-Signature": signWebhook(rawBody, secret),
      },
      body: rawBody,
    });
    if (!res.ok) return { id: cfg.id, ok: false, detail: `HTTP ${res.status}` };
    return { id: cfg.id, ok: true, detail: "delivered" };
  } catch (err: any) {
    return { id: cfg.id, ok: false, detail: err?.message ?? "request failed" };
  }
}
```

- [ ] **Step 2: Rewrite the fan-out in `publishNow`**

Replace the body of `publishNow` (lines ~93–121) with:

```ts
export async function publishNow(
  record: PublicationRecord,
  targets: PublishTargets,
  seriesLink: string,
  tags: string[]
): Promise<{ results: TargetResult[]; summary: string }> {
  const allWebhooks = await listWebhooks();
  const enabled = targets.webhooks
    .map((id) => allWebhooks.find((w) => w.id === id))
    .filter((w): w is WebhookConfig => !!w);
  const canonicalUrl = canonicalUrlFromWebhook(enabled[0]?.url ?? null, slugify(record.title ?? ""));

  const jobs: Promise<TargetResult>[] = [];
  if (targets.devto) {
    jobs.push(postDevto(record.title ?? "", record.articleMarkdown ?? "", canonicalUrl, tags));
  }
  for (const id of ["linkedin", "substack"] as const) {
    if (targets[id]) jobs.push(Promise.resolve({ id, ok: false, detail: "not supported" }));
  }
  for (const cfg of enabled) {
    jobs.push(
      getWebhookSecret(cfg.id).then((secret) =>
        secret
          ? postWebhook(cfg, secret, record, seriesLink, canonicalUrl)
          : ({ id: cfg.id, ok: false, detail: "not configured" } as TargetResult)
      )
    );
  }
  const results = await Promise.all(jobs);

  if (results.some((r) => r.ok)) {
    await markPublished(record.repoName, {
      title: record.title ?? "",
      publishedAt: new Date().toISOString(),
      articleMarkdown: record.articleMarkdown ?? "",
    });
  }
  return { results, summary: summarizeResults(results) };
}
```

Update the import from `./lib/publish` to drop `TargetId`/`canonicalUrlFor` (removed) and keep `buildWebhookPayload`, `selectedTargets`, `signWebhook`, `slugify`, `summarizeResults`, `buildDevtoArticle`, `PublishTargets`, `TargetResult`.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Run the affected suites**

Run: `npx vitest run src/diffpress/`
Expected: PASS. If `ledger.scheduled.test.ts` constructs a `targets` literal with `diffpress`/`thephilgray`, update it to `{ devto, linkedin, substack, webhooks: [...] }`.

- [ ] **Step 5: Commit**

```bash
git add src/diffpress/publishArticle.ts src/diffpress/lib/ledger.scheduled.test.ts
git commit -m "feat(diffpress): publish fan-out over DB-backed webhooks + SSM secrets"
```

---

### Task 6: Frontend types + services

**Files:**
- Modify: `src/components/diffpress/types.ts`
- Modify: `src/components/diffpress/services.ts`

**Interfaces:**
- Produces:
  - `interface SyndicationTargets { devto: boolean; linkedin: boolean; substack: boolean; webhooks: string[] }`
  - `interface WebhookConfig { id: string; name: string; url: string }`
  - `PublishTargetResult.id: string`
  - services: `listWebhooks()`, `saveWebhook(input)`, `deleteWebhook(id)`, `testWebhook(input)`

- [ ] **Step 1: Update `types.ts`**

Replace `SyndicationTargets` (lines ~82–88):

```ts
export interface SyndicationTargets {
  devto: boolean;
  linkedin: boolean;
  substack: boolean;
  webhooks: string[]; // enabled webhook ids
}

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
}
```

Change `PublishTargetResult.id` (line ~91) from `keyof SyndicationTargets` to `string`.

- [ ] **Step 2: Add the service calls to `services.ts`**

Append (using the existing `authedFetch` helper):

```ts
import type { WebhookConfig } from "./types";

export async function listWebhooks(): Promise<WebhookConfig[]> {
  const res = await authedFetch("/api/webhooks");
  if (!res.ok) throw new Error(`Failed to load webhooks (${res.status})`);
  return (await res.json()).webhooks;
}

export async function saveWebhook(input: {
  id?: string;
  name: string;
  url: string;
  secret?: string;
}): Promise<WebhookConfig> {
  const res = await authedFetch("/api/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to save webhook (${res.status})`);
  return (await res.json()).webhook;
}

export async function deleteWebhook(id: string): Promise<void> {
  const res = await authedFetch(`/api/webhooks?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to delete webhook (${res.status})`);
}

export async function testWebhook(input: {
  id?: string;
  url?: string;
  secret?: string;
}): Promise<{ ok: boolean; status: number }> {
  const res = await authedFetch("/api/webhooks/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Failed to test webhook (${res.status})`);
  return res.json();
}
```

If `WebhookConfig` is already imported in `services.ts` via an existing type import line, add it there instead of a new import.

- [ ] **Step 3: Typecheck the frontend**

Run: `npx tsc --noEmit`
Expected: errors only in `store.ts`/`PublishConsole.tsx` referencing removed `diffpress`/`thephilgray` keys — fixed in Tasks 7–8. No errors in `types.ts`/`services.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/components/diffpress/types.ts src/components/diffpress/services.ts
git commit -m "feat(diffpress): frontend webhook types + service calls"
```

---

### Task 7: Frontend store

**Files:**
- Modify: `src/components/diffpress/store.ts`

**Interfaces:**
- Consumes: services from Task 6; `WebhookConfig`, `SyndicationTargets` from Task 6.
- Produces store additions: `webhooks: WebhookConfig[]`, `loadWebhooks()`, `saveWebhook(input)`, `deleteWebhook(id)`, `testWebhook(input)`, `toggleWebhook(id)`; updated `targets` default.

- [ ] **Step 1: Update the targets default and add webhook state**

Find the `targets:` default in the store initializer (~line 160 region). Replace the literal with:

```ts
  targets: { devto: false, linkedin: false, substack: false, webhooks: [] },
  webhooks: [],
```

Add to the `DiffPressState` interface (near line ~160–177): `webhooks: WebhookConfig[];` and the action signatures:

```ts
  loadWebhooks: () => Promise<void>;
  saveWebhook: (input: { id?: string; name: string; url: string; secret?: string }) => Promise<void>;
  deleteWebhook: (id: string) => Promise<void>;
  testWebhook: (input: { id?: string; url?: string; secret?: string }) => Promise<{ ok: boolean; status: number }>;
  toggleWebhook: (id: string) => void;
```

Import the new services and `WebhookConfig` type at the top of the file (extend the existing `services`/`types` import lines).

- [ ] **Step 2: Implement the actions**

Add to the store body (near `toggleTarget`, ~line 171 region):

```ts
  toggleWebhook: (id) =>
    set((s) => {
      const on = s.targets.webhooks.includes(id);
      return {
        targets: {
          ...s.targets,
          webhooks: on ? s.targets.webhooks.filter((w) => w !== id) : [...s.targets.webhooks, id],
        },
      };
    }),
  loadWebhooks: async () => {
    try {
      set({ webhooks: await listWebhooks() });
    } catch {
      set({ webhooks: [] });
    }
  },
  saveWebhook: async (input) => {
    await saveWebhook(input);
    await get().loadWebhooks();
  },
  deleteWebhook: async (id) => {
    await deleteWebhook(id);
    set((s) => ({ targets: { ...s.targets, webhooks: s.targets.webhooks.filter((w) => w !== id) } }));
    await get().loadWebhooks();
  },
  testWebhook: async (input) => testWebhook(input),
```

If `toggleTarget` (line ~171) still references `diffpress`/`thephilgray`, it does not need changes — it operates on `keyof` the boolean fields; ensure its type is `(id: "devto" | "linkedin" | "substack") => void`.

- [ ] **Step 3: Load webhooks when the publish console opens**

Find the action that sets `publishOpen: true` (the openPublish/deploy-open path). Add `get().loadWebhooks();` there so the list is fresh when the console opens.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: errors now only in `PublishConsole.tsx` (Task 8).

- [ ] **Step 5: Commit**

```bash
git add src/components/diffpress/store.ts
git commit -m "feat(diffpress): webhook CRUD + toggle actions in publish store"
```

---

### Task 8: PublishConsole UI

Replace the static webhook rows with a dynamic, editable list + add form + test indicator.

**Files:**
- Modify: `src/components/diffpress/PublishConsole.tsx`

**Interfaces:**
- Consumes: store `webhooks`, `targets.webhooks`, `toggleWebhook`, `saveWebhook`, `deleteWebhook`, `testWebhook` (Task 7).

- [ ] **Step 1: Trim the static TARGETS list**

In the `TARGETS` array (lines ~9–45), remove the `diffpress` and `thephilgray` entries. Keep `devto`, `linkedin`, `substack`. Update the `id` type to `"devto" | "linkedin" | "substack"`.

- [ ] **Step 2: Pull webhook state + actions from the store**

In the component body (near the existing `useDiffPress` selectors, ~line 54), add:

```ts
  const webhooks = useDiffPress((s) => s.webhooks);
  const enabledWebhooks = useDiffPress((s) => s.targets.webhooks);
  const toggleWebhook = useDiffPress((s) => s.toggleWebhook);
  const saveWebhook = useDiffPress((s) => s.saveWebhook);
  const deleteWebhook = useDiffPress((s) => s.deleteWebhook);
  const testWebhook = useDiffPress((s) => s.testWebhook);
```

- [ ] **Step 3: Render the dynamic webhook section**

After the static targets `.map(...)` block (~line 150), before the Tags section, add a webhook list with toggle + edit/delete, an "Add webhook" toggle, and an inline editor. Add local state at the top of the component:

```ts
  const [editor, setEditor] = useState<{ id?: string; name: string; url: string; secret: string } | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; status: number } | null>(null);
```

Render (Tailwind utility classes consistent with the existing rows):

```tsx
            <SectionLabel>Signed webhooks</SectionLabel>
            <div className="mb-3">
              {webhooks.map((w) => (
                <div key={w.id} className="flex items-center gap-[14px] py-3">
                  <span className="flex flex-[0_0_auto] text-[#8a877f]"><Globe size={19} strokeWidth={1.7} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14.5px] font-medium">{w.name}</div>
                    <div className="truncate text-[12px] text-dp-faint-2">{w.url}</div>
                  </div>
                  <button
                    onClick={() => { setEditor({ id: w.id, name: w.name, url: w.url, secret: "" }); setTestResult(null); }}
                    className="cursor-pointer border-none bg-transparent p-1 text-[12px] text-dp-faint hover:text-dp-ink"
                  >Edit</button>
                  <button
                    onClick={() => deleteWebhook(w.id)}
                    aria-label={`Delete ${w.name}`}
                    className="cursor-pointer border-none bg-transparent p-1 text-dp-faint hover:text-red-500"
                  ><X size={16} strokeWidth={1.8} /></button>
                  <Toggle on={enabledWebhooks.includes(w.id)} onChange={() => toggleWebhook(w.id)} label={w.name} />
                </div>
              ))}
            </div>

            {editor ? (
              <div className="mb-7 rounded-[10px] bg-[#f6f5f1] p-[14px]">
                <input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  placeholder="Name (e.g. diffpress.com)"
                  className="mb-2 w-full border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] font-dp-mono text-[14px] outline-none"
                />
                <input
                  value={editor.url}
                  onChange={(e) => setEditor({ ...editor, url: e.target.value })}
                  placeholder="https://example.com/webhook"
                  className="mb-2 w-full border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] font-dp-mono text-[14px] outline-none"
                />
                <div className="mb-3 flex items-center gap-2">
                  <input
                    value={editor.secret}
                    onChange={(e) => setEditor({ ...editor, secret: e.target.value })}
                    placeholder={editor.id ? "Secret (blank = keep current)" : "Signing secret"}
                    className="flex-1 border-none border-b-[1.5px] border-dp-line bg-transparent py-[6px] font-dp-mono text-[14px] outline-none"
                  />
                  <button
                    onClick={() => setEditor({ ...editor, secret: Array.from(crypto.getRandomValues(new Uint8Array(32))).map((b) => b.toString(16).padStart(2, "0")).join("") })}
                    className="cursor-pointer rounded-[7px] border-none bg-[#e4e2db] px-[10px] py-[6px] text-[12px] hover:opacity-90"
                  >Generate</button>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={async () => {
                      await saveWebhook({ id: editor.id, name: editor.name, url: editor.url, secret: editor.secret || undefined });
                      setEditor(null); setTestResult(null);
                    }}
                    className="cursor-pointer rounded-[8px] border-none bg-dp-ink px-[14px] py-[8px] text-[13px] font-medium text-dp-paper hover:opacity-90"
                  >Save</button>
                  <button
                    onClick={async () => setTestResult(await testWebhook({ id: editor.id, url: editor.url, secret: editor.secret || undefined }))}
                    className="cursor-pointer rounded-[8px] border-none bg-[#e4e2db] px-[14px] py-[8px] text-[13px] hover:opacity-90"
                  >Test</button>
                  {testResult && (
                    <span className={cn("text-[12px]", testResult.ok ? "text-dp-green" : "text-red-500")}>
                      {testResult.ok ? `✓ ${testResult.status}` : `✗ ${testResult.status || "failed"}`}
                    </span>
                  )}
                  <button onClick={() => { setEditor(null); setTestResult(null); }} className="ml-auto cursor-pointer border-none bg-transparent text-[12px] text-dp-faint hover:text-dp-ink">Cancel</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => { setEditor({ name: "", url: "", secret: "" }); setTestResult(null); }}
                className="mb-7 cursor-pointer rounded-[8px] border-[1.5px] border-dashed border-dp-line bg-transparent px-[14px] py-[10px] text-[13px] text-dp-faint hover:text-dp-ink"
              >+ Add webhook</button>
            )}
```

- [ ] **Step 4: Confirm the deploy gate still works**

`anyTarget` (line ~71) uses `Object.values(targets).some(Boolean)`. With `webhooks: []` an empty array is truthy — change the gate to count real selections:

```ts
  const anyTarget = targets.devto || targets.linkedin || targets.substack || targets.webhooks.length > 0;
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: PASS across the whole project.

- [ ] **Step 6: Commit**

```bash
git add src/components/diffpress/PublishConsole.tsx
git commit -m "feat(diffpress): in-UI webhook config — list, add/edit/delete, test connection"
```

---

### Task 9: Deploy + end-to-end verification

**Files:** none (operational).

- [ ] **Step 1: Deploy** (Phil-gated — requires AWS creds)

Run: `npx sst deploy --stage <stage>`
Expected: `WebhookConfig` table created; `/api/webhooks*` routes live; `sst-env.d.ts` regenerated (the `Resource` cast in `lib/webhooks.ts` now matches a real type).

- [ ] **Step 2: Re-add the two existing webhooks in the UI**

Open the publish console → Add webhook for `diffpress.com` and `thephilgray.com` (their URLs + freshly generated secrets, pasted into each receiver). The retired `PUBLISH_WEBHOOKS` secret is no longer read.

- [ ] **Step 3: Test connection**

Click Test on each — expect `✓` with a 2xx/4xx status (any HTTP response proves reachability + signature path).

- [ ] **Step 4: Publish a real article to one webhook**

Deploy an article with one webhook enabled; confirm the per-target result row shows `delivered` and the receiver got a valid `X-DiffPress-Signature`.

- [ ] **Step 5: Final typecheck + full test run**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS.

---

## Self-Review

**Spec coverage:**
- §1 storage (table + SSM derived param) → Tasks 2, 4.
- §2 backend (CRUD, test, publish rewire, IAM) → Tasks 3, 4, 5.
- §3 targets model → Task 1.
- §4 canonical → Task 1 (+ used in Task 5).
- §5 secret handling (SSM, generate, never returned) → Tasks 2, 3, 8.
- §6 frontend → Tasks 6, 7, 8.
- §7 testing → Tasks 1, 2 carry the pure tests.

**Type consistency:** `PublishTargets`/`SyndicationTargets` both become `{ devto, linkedin, substack, webhooks: string[] }`; `TargetResult.id`/`PublishTargetResult.id` both `string`; `WebhookConfig` `{ id, name, url(, createdAt backend-only) }`; service/store/handler names match across tasks (`listWebhooks`, `saveWebhook`, `deleteWebhook`, `testWebhook`, `toggleWebhook`).

**Placeholder scan:** none — every code step carries complete code.
