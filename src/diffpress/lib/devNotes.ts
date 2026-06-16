// src/diffpress/lib/devNotes.ts
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";

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
