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
