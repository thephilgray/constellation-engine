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

// ponytail: `getCreatedAt` re-scans to preserve ordering on edit. Fine at single-digit webhook counts; swap for a `GetCommand` if the table ever grows.
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
