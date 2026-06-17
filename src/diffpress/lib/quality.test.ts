import { describe, it, expect } from "vitest";
import {
  hasOpenSourceLicense,
  isEnglishReadable,
  hasRealLanguage,
  isMetaRepo,
  passesQualityBar,
  type RepoMetadata,
} from "./quality";

describe("hasOpenSourceLicense", () => {
  it("accepts a recognized SPDX id", () => {
    expect(hasOpenSourceLicense("MIT")).toBe(true);
    expect(hasOpenSourceLicense("Apache-2.0")).toBe(true);
  });
  it("rejects missing / unclassified licenses", () => {
    expect(hasOpenSourceLicense(null)).toBe(false);
    expect(hasOpenSourceLicense(undefined)).toBe(false);
    expect(hasOpenSourceLicense("NOASSERTION")).toBe(false);
    expect(hasOpenSourceLicense("Other")).toBe(false);
  });
});

describe("isEnglishReadable", () => {
  it("accepts a normal English description", () => {
    expect(isEnglishReadable("A fast, type-safe state manager for React.")).toBe(true);
  });
  it("accepts Latin-script with a little punctuation/emoji", () => {
    expect(isEnglishReadable("⚡ Blazing fast bundler")).toBe(true);
  });
  it("rejects predominantly non-Latin descriptions", () => {
    expect(isEnglishReadable("一个简单易用的中文工具库，支持多种功能")).toBe(false);
  });
  it("rejects empty or symbol-only descriptions", () => {
    expect(isEnglishReadable("")).toBe(false);
    expect(isEnglishReadable(null)).toBe(false);
    expect(isEnglishReadable("★★★ 123 !!!")).toBe(false);
  });
});

describe("hasRealLanguage", () => {
  it("accepts programming languages", () => {
    expect(hasRealLanguage("TypeScript")).toBe(true);
    expect(hasRealLanguage("Rust")).toBe(true);
  });
  it("rejects docs/markup-only and null languages", () => {
    expect(hasRealLanguage("Markdown")).toBe(false);
    expect(hasRealLanguage("HTML")).toBe(false);
    expect(hasRealLanguage(null)).toBe(false);
  });
});

describe("isMetaRepo", () => {
  it("flags list/learning repos by name", () => {
    expect(isMetaRepo("sindresorhus/awesome", [])).toBe(true);
    expect(isMetaRepo("kamranahmedse/developer-roadmap", [])).toBe(true);
  });
  it("flags by topic", () => {
    expect(isMetaRepo("acme/widgets", ["awesome-list", "tools"])).toBe(true);
  });
  it("passes genuine software repos", () => {
    expect(isMetaRepo("vercel/next.js", ["react", "framework"])).toBe(false);
  });
});

describe("passesQualityBar", () => {
  const good: RepoMetadata = {
    name: "vercel/next.js",
    description: "The React Framework for the Web.",
    language: "TypeScript",
    topics: ["react", "framework"],
    licenseSpdxId: "MIT",
    stars: 5000,
    archived: false,
    disabled: false,
  };

  it("accepts a clean software repo", () => {
    expect(passesQualityBar(good)).toBe(true);
  });
  it("rejects archived/disabled, below floor, no license, junk desc, meta, docs-only", () => {
    expect(passesQualityBar({ ...good, archived: true })).toBe(false);
    expect(passesQualityBar({ ...good, stars: 10 })).toBe(false);
    expect(passesQualityBar({ ...good, licenseSpdxId: null })).toBe(false);
    expect(passesQualityBar({ ...good, description: "中文项目工具库支持" })).toBe(false);
    expect(passesQualityBar({ ...good, name: "x/awesome-things" })).toBe(false);
    expect(passesQualityBar({ ...good, language: "Markdown" })).toBe(false);
  });
});
