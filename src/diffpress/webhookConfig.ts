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
