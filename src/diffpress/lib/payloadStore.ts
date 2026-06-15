// src/diffpress/lib/payloadStore.ts
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { Resource } from "sst";
import type { EnrichmentPayload, PayloadLocation } from "../types";

const s3 = new S3Client({});

function bucketName(): string {
  return (Resource as unknown as { ContentPayloadBucket: { name: string } }).ContentPayloadBucket.name;
}

/** Store an enrichment payload as JSON and return its S3 location. */
export async function putPayload(
  key: string,
  payload: EnrichmentPayload
): Promise<PayloadLocation> {
  const bucket = bucketName();
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(payload),
      ContentType: "application/json",
    })
  );
  return { bucket, key };
}

/** Read and parse an enrichment payload from S3. Throws if missing/unreadable. */
export async function getPayload(key: string): Promise<EnrichmentPayload> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: bucketName(), Key: key })
  );
  if (!res.Body) {
    throw new Error(`Enrichment payload not found at key: ${key}`);
  }
  const body = await res.Body.transformToString();
  return JSON.parse(body) as EnrichmentPayload;
}
