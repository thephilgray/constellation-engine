import { describe, it, expect } from "vitest";
import { mdToHtml, htmlToMd } from "./markdownHtml";

describe("markdown <-> html round-trip", () => {
  const md = [
    "# Title",
    "",
    "A paragraph with **bold**, *italic*, and `inline code`.",
    "",
    "## Section",
    "",
    "- one",
    "- two",
    "",
    "> a quote",
    "",
    "```",
    "const x = 1;",
    "```",
    "",
    "[a link](https://example.com)",
    "",
  ].join("\n");

  it("preserves the structural elements through md -> html -> md", () => {
    const back = htmlToMd(mdToHtml(md));
    expect(back).toContain("# Title");
    expect(back).toContain("## Section");
    expect(back).toContain("**bold**");
    expect(back).toContain("*italic*");
    expect(back).toContain("`inline code`");
    expect(back).toMatch(/- +one/);
    expect(back).toContain("> a quote");
    expect(back).toContain("const x = 1;");
    expect(back).toContain("[a link](https://example.com)");
  });
});
