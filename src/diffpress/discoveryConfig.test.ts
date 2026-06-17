import { describe, it, expect } from "vitest";
import { validateConfigInput } from "./discoveryConfig";

describe("validateConfigInput", () => {
  it("accepts a valid config", () => {
    expect(
      validateConfigInput({ engineState: "paused", discoveryMode: "ecosystem", velocity: 10 })
    ).toEqual({ engineState: "paused", discoveryMode: "ecosystem", velocity: 10 });
  });

  it("clamps velocity to 1–20 and rounds", () => {
    expect(validateConfigInput({ engineState: "active", discoveryMode: "frontier", velocity: 99 })?.velocity).toBe(20);
    expect(validateConfigInput({ engineState: "active", discoveryMode: "frontier", velocity: 0 })?.velocity).toBe(1);
    expect(validateConfigInput({ engineState: "active", discoveryMode: "frontier", velocity: 6.7 })?.velocity).toBe(7);
  });

  it("rejects bad enums", () => {
    expect(validateConfigInput({ engineState: "nope", discoveryMode: "frontier", velocity: 6 })).toBeNull();
    expect(validateConfigInput({ engineState: "active", discoveryMode: "nope", velocity: 6 })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(validateConfigInput(null)).toBeNull();
    expect(validateConfigInput("x")).toBeNull();
  });

  it("falls back to defaults for missing fields", () => {
    expect(validateConfigInput({})).toEqual({
      engineState: "active",
      discoveryMode: "frontier",
      velocity: 6,
    });
  });
});
