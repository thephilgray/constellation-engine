// Bridge between the markdown stored in the ledger and the HTML the
// contenteditable DraftEditor works in. Markdown stays canonical: we render it
// to HTML to seed the editor, and serialize the edited HTML back to markdown
// on save.
import { marked } from "marked";
import TurndownService from "turndown";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  emDelimiter: "*",
});

export function mdToHtml(md: string): string {
  // No async marked extensions are registered, so parse is synchronous.
  return marked.parse(md, { async: false }) as string;
}

export function htmlToMd(html: string): string {
  return turndown.turndown(html).trim() + "\n";
}
