import { describe, it, expect } from "vitest";
import { paramName, slugId, validateWebhookInput } from "./webhooks";

describe("paramName", () => {
  it("builds a stage-scoped SSM path from id", () => {
    expect(paramName("prod", "wh_abc")).toBe("/diffpress/prod/webhooks/wh_abc");
  });
});

describe("slugId", () => {
  it("produces wh_<slug>_<6hex>", () => {
    const id = slugId("My Site!");
    expect(id).toMatch(/^wh_my-site_[0-9a-f]{6}$/);
  });
});

describe("validateWebhookInput", () => {
  it("requires a non-empty name and a valid http(s) url", () => {
    expect(validateWebhookInput({ name: "", url: "https://x.com" }).ok).toBe(false);
    expect(validateWebhookInput({ name: "X", url: "ftp://x" }).ok).toBe(false);
    const ok = validateWebhookInput({ name: "X", url: "https://x.com", secret: "s" });
    expect(ok.ok).toBe(true);
  });
  it("requires a secret on create (no id) but allows blank on edit (with id)", () => {
    expect(validateWebhookInput({ name: "X", url: "https://x.com" }).ok).toBe(false);
    expect(validateWebhookInput({ id: "wh_a", name: "X", url: "https://x.com" }).ok).toBe(true);
  });
});
