// Quality heuristics for Discovery candidates.
//
// GH Archive gives us velocity; these filters keep the board to repos that are
// actually open-source, English-readable, and usable as the basis for a demo
// project — screening out the junk/meta/non-OSI repos that raw trending surfaces.
// The thresholds and word lists are deliberately simple and tunable.

/** Minimum absolute stars so velocity on tiny/empty repos can't dominate. */
export const STAR_FLOOR = 250;

/** Min share of letters that must be Latin-script for a description to "read". */
export const ENGLISH_LATIN_RATIO = 0.6;

/** Primary languages that signal a docs/markup repo, not a demoable library. */
export const DOC_ONLY_LANGUAGES = new Set([
  "Markdown",
  "HTML",
  "CSS",
  "TeX",
  "Roff",
]);

/**
 * Substrings that flag a list/learning/meta repo rather than usable software.
 * Matched against the repo name and its GitHub topics (case-insensitive).
 */
export const META_KEYWORDS = [
  "awesome",
  "roadmap",
  "tutorial",
  "interview",
  "cheatsheet",
  "cheat-sheet",
  "resources",
  "course",
  "handbook",
  "papers",
  "books",
  "free-programming",
];

/** Repo metadata we read off `octokit.repos.get` for filtering. */
export interface RepoMetadata {
  name: string; // "owner/repo" or bare repo name
  description: string | null;
  language: string | null;
  topics: string[];
  licenseSpdxId: string | null;
  stars: number;
  archived: boolean;
  disabled: boolean;
}

/**
 * True when GitHub recognized a real license. `octokit` returns a `license`
 * object only when it classifies the LICENSE file; "NOASSERTION"/"Other"/null
 * mean it couldn't, which for our purposes means "not safely reusable".
 */
export function hasOpenSourceLicense(spdxId: string | null | undefined): boolean {
  if (!spdxId) return false;
  return spdxId !== "NOASSERTION" && spdxId !== "Other";
}

/** True when the description is present and predominantly Latin-script. */
export function isEnglishReadable(description: string | null | undefined): boolean {
  if (!description) return false;
  const letters = [...description].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) return false;
  const latin = letters.filter((ch) => /\p{Script=Latin}/u.test(ch)).length;
  return latin / letters.length >= ENGLISH_LATIN_RATIO;
}

/** True when the primary language is a programming language (not docs/markup). */
export function hasRealLanguage(language: string | null | undefined): boolean {
  if (!language) return false;
  return !DOC_ONLY_LANGUAGES.has(language);
}

/** True when the repo name or topics look like a list/learning/meta repo. */
export function isMetaRepo(name: string, topics: string[]): boolean {
  const repo = (name.split("/").pop() ?? name).toLowerCase();
  const haystacks = [repo, ...topics.map((t) => t.toLowerCase())];
  return META_KEYWORDS.some((kw) => haystacks.some((h) => h.includes(kw)));
}

/** Combined gate: a candidate must clear every quality check to surface. */
export function passesQualityBar(
  meta: RepoMetadata,
  starFloor: number = STAR_FLOOR
): boolean {
  if (meta.archived || meta.disabled) return false;
  if (meta.stars < starFloor) return false;
  if (!hasOpenSourceLicense(meta.licenseSpdxId)) return false;
  if (!isEnglishReadable(meta.description)) return false;
  if (!hasRealLanguage(meta.language)) return false;
  if (isMetaRepo(meta.name, meta.topics)) return false;
  return true;
}
