# In-UI Webhook Configuration — Design

**Date:** 2026-06-26
**Status:** Approved (pending spec review)
**Supersedes constraint:** The `2026-06-25-diffpress-publishing-pipeline` plan deliberately chose "Secrets only — no DB-backed config UI." This feature reverses that for the webhook targets specifically, replacing the static `PUBLISH_WEBHOOKS` secret with user-managed, persisted webhook configs.

## Goal

Let the user add, edit, delete, and test an arbitrary number of signed-webhook syndication targets from the DiffPress publish console — replacing the two hardcoded targets (`diffpress`, `thephilgray`) and their `PUBLISH_WEBHOOKS` JSON secret.

Dev.to stays special (API + `DEVTO_API_KEY` secret). `linkedin`/`substack` remain untouched stub toggles.

## Scope

**In v1:**
- CRUD for webhooks, each with three user-facing fields: **name, URL, secret** (HMAC signing key).
- "Generate secret" affordance.
- "Test connection" — send a signed ping and surface the HTTP result + a status indicator.
- Secrets stored encrypted in SSM Parameter Store (`SecureString`), never in DynamoDB, never returned to the browser.

**Deliberately cut (YAGNI):**
- Configurable HTTP method / payload format / custom headers. All receivers use `POST` + JSON + `X-DiffPress-Signature`, hardcoded as today.
- Migration script for the two existing webhook configs — only two entries; re-add them in the UI after deploy.
- Per-webhook "primary/canonical" flag — canonical base is derived (see §5).

## The core shift

Today the two webhook targets are hardcoded in four places:
- `TargetId` union `"diffpress" | "thephilgray"` (`lib/publish.ts:3`)
- `DOMAIN_BASE` constant (`lib/publish.ts:50`)
- the `switch` arm in `publishNow` (`publishArticle.ts:104`)
- the `PUBLISH_WEBHOOKS` JSON secret read by `webhookConfigs()` (`publishArticle.ts:24`)

All four are replaced by a **DynamoDB-backed list of arbitrary webhook configs** plus **SSM-stored secrets**.

## 1. Storage

**New `WebhookConfig` Dynamo table:** `hashKey: id`. Item shape:

```
{ id: string, name: string, url: string, createdAt: string }
```

No secret, no secret reference — the SSM parameter name is **derived** from `id`.

**Secrets:** each webhook's HMAC secret is an SSM `SecureString` parameter at:

```
/diffpress/<stage>/webhooks/<id>
```

KMS-encrypted with the AWS-managed `alias/aws/ssm` key (no KMS setup, standard-tier params are free). `<stage>` isolates dev/prod.

`id` is a generated slug/uuid (server-side on create). `PUBLISH_WEBHOOKS` secret is retired.

## 2. Backend

All routes JWT-authed via the existing `authorizer`, matching every other `/api/*` route.

**New handler `src/diffpress/webhookConfig.ts`:**
- `GET /api/webhooks` → list of `{ id, name, url }`. **Secret never returned.** (Every persisted webhook has a secret by construction, so no `hasSecret` flag is needed.)
- `POST /api/webhooks` → upsert. Body `{ id?, name, url, secret? }`. On create, `secret` required → `PutParameter`. On edit, blank `secret` = keep existing (skip `PutParameter`); non-blank = overwrite.
- `DELETE /api/webhooks?id=` → `DeleteCommand` on the table + `ssm:DeleteParameter`.

**New route `POST /api/webhooks/test`** (same handler or a thin sibling):
- Body `{ url, secret }` (new/changed webhook — transient, never stored) **or** `{ id }` (existing — reads SSM `GetParameter`).
- Sends `POST` to `url` with body `{ test: true }`, header `X-DiffPress-Signature: <signWebhook(body, secret)>`.
- Returns `{ ok: boolean, status: number }`. Any HTTP response (even 4xx) proves reachability + that the signature path ran; network error → `{ ok: false }`.

**Modified `publishArticle.ts` + `publishScheduled.ts`:**
- `webhookConfigs()` reads the `WebhookConfig` table instead of the `PUBLISH_WEBHOOKS` secret; the secret for each enabled id comes from `ssm:GetParameter` (`WithDecryption: true`).
- The `case "diffpress": case "thephilgray":` arm in `publishNow` becomes generic: any enabled webhook id → `postWebhook(config, secret, …)`.

**IAM (`sst.config.ts`):**
- New `WebhookConfig` table `link`ed into `publishArticle`, `publishScheduled`, and `webhookConfig` handlers.
- Grant those three handlers `ssm:GetParameter` (publish + cron + test), `ssm:PutParameter`/`ssm:DeleteParameter` (CRUD handler only) on resource `arn:aws:ssm:*:*:parameter/diffpress/<stage>/webhooks/*`.
- Remove `PUBLISH_WEBHOOKS` from the `link` arrays (and its `sst.Secret` declaration once nothing references it).

## 3. Targets model (`lib/publish.ts`)

- `PublishTargets` keeps `devto/linkedin/substack` booleans; **add `webhooks: string[]`** — the enabled webhook ids.
- `TargetResult.id` widens `TargetId → string` (webhook ids are dynamic).
- `selectedTargets` returns the fixed enabled booleans plus each id in `webhooks`.
- `parsePublishInput` validates `webhooks` is a string array; unknown ids are dropped at publish time (a webhook deleted between console-open and publish simply yields no result).

## 4. Canonical URL (`lib/publish.ts`)

`DOMAIN_BASE` and `canonicalUrlFor`'s domain logic are removed. New rule:

> canonical base = `new URL(cfg.url).origin` of the **first enabled webhook** (by stable order); if no webhook is enabled, no `canonical_url` is sent to Dev.to.

`buildWebhookPayload` / `buildDevtoArticle` receive the resolved canonical URL as a parameter rather than computing it from a hardcoded map.

**Simplification:** first-enabled-wins. Add a per-webhook "primary" flag later only if this proves wrong.

## 5. Secret handling (security)

- Secrets live **only** in SSM `SecureString` (KMS-encrypted at rest, separate IAM surface from the DB).
- **Generate:** client generates a 32-byte hex via `crypto.getRandomValues`, shown once for the user to paste into the receiving service. Sent to the backend only on save.
- **Never re-displayed:** no GET returns a secret. Editing shows a blank secret field; leaving it blank keeps the stored value.
- This is the multi-user-safe pattern from day one — no plaintext-in-DB anti-pattern to remediate before productizing.

## 6. Frontend

- **`store.ts`:** add `webhooks` list state + actions `loadWebhooks`, `saveWebhook`, `deleteWebhook`, `testWebhook`. `targets` gains the `webhooks: string[]` enabled-id set; `toggleTarget` handles webhook ids.
- **`PublishConsole.tsx`:** the static webhook rows in `TARGETS` become a **dynamic list** rendered from `webhooks` — each row has a toggle, edit, and delete control. Below it, an **"Add webhook"** row. Editing/adding opens an inline editor: name / url / secret (+ generate) / test button with a result dot. `devto`, `linkedin`, `substack` stay as the existing static rows.
- **`services.ts`:** the four new API calls (`GET/POST/DELETE /api/webhooks`, `POST /api/webhooks/test`).
- **`types.ts`:** `SyndicationTargets` adds `webhooks: string[]`; new `WebhookConfig` type `{ id, name, url }`.

## 7. Testing

Following the existing pattern (pure logic in `lib/publish.ts` carries the unit tests; handlers are thin glue):
- `canonicalUrlFromWebhook` — derives origin from the first enabled webhook; empty when none.
- `parsePublishInput` — accepts/validates the `webhooks` string array.
- test-ping signing — `signWebhook` over the `{ test: true }` body is stable and matches the publish-path signature.

Handler/SSM/Dynamo I/O stays untested glue (or mocked if a handler test already exists), per the pipeline plan's convention.

## Open items resolved

- **Secret storage** → SSM `SecureString`, derived param name, nothing secret in DynamoDB. (User-raised; correct pattern is cheap now, so done now.)
- **Field scope** → name/url/secret only.
- **Test connection** → included.
- **CRUD breadth** → arbitrary add/remove.
