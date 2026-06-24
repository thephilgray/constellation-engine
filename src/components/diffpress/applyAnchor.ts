/**
 * Apply a review note by replacing the first occurrence of `anchorText` with
 * `replacement`. Pure string op (anchorText is verbatim, not a regex). If the
 * anchor isn't found, the markdown is returned unchanged and `applied` is false.
 */
export function applyAnchor(
  markdown: string,
  anchorText: string,
  replacement: string,
): { applied: boolean; markdown: string } {
  const i = markdown.indexOf(anchorText);
  if (i === -1) return { applied: false, markdown };
  return {
    applied: true,
    markdown: markdown.slice(0, i) + replacement + markdown.slice(i + anchorText.length),
  };
}
