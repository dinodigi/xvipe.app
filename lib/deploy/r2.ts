/**
 * lib/deploy/r2.ts — durable bundle storage on Cloudflare R2 (P1.4/P1.5).
 *
 * Publishes push each version to R2 as immutable objects plus a small
 * `current.json` pointer per app:
 *
 *   <slug>/v<N>/<file...>     — the bundle, byte-for-byte
 *   <slug>/current.json       — { version, publishedAt, files[] }
 *
 * v1 serving still happens from the studio host (Render); R2 is the durable
 * copy and the exact layout a future edge worker will read (resolve
 * current.json → serve v<N>/*). Deploys stay byte copies — nothing here
 * executes app code.
 */
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentTypeFor } from "@/lib/apps/mime";
import type { WsFile } from "@/lib/apps/store";

export function r2Configured(): boolean {
  return Boolean(
    process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET,
  );
}

let client: S3Client | undefined;
function r2(): S3Client {
  client ??= new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return client;
}

export interface R2UploadResult {
  uploaded: number;
  bytes: number;
  prefix: string;
}

/** Push one published snapshot (already on disk) to R2. */
export async function uploadBundle(slug: string, version: number, snapshotDir: string, files: WsFile[]): Promise<R2UploadResult> {
  const bucket = process.env.R2_BUCKET!;
  const prefix = `${slug}/v${version}/`;
  let bytes = 0;

  for (const file of files) {
    const body = readFileSync(join(snapshotDir, file.path));
    bytes += body.byteLength;
    await r2().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: prefix + file.path,
        Body: body,
        ContentType: contentTypeFor(file.path),
        CacheControl: "public, max-age=31536000, immutable", // versioned prefix → immutable
      }),
    );
  }

  await r2().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${slug}/current.json`,
      Body: JSON.stringify({ version, publishedAt: new Date().toISOString(), files: files.map((f) => f.path) }),
      ContentType: "application/json",
      CacheControl: "no-cache",
    }),
  );

  return { uploaded: files.length + 1, bytes, prefix };
}

/** Rollback support: repoint current.json at an existing immutable version. */
export async function repointCurrent(slug: string, version: number, files: string[]): Promise<void> {
  await r2().send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET!,
      Key: `${slug}/current.json`,
      Body: JSON.stringify({ version, publishedAt: new Date().toISOString(), files, rolledBack: true }),
      ContentType: "application/json",
      CacheControl: "no-cache",
    }),
  );
}
