import { describe, it, expect } from "vitest";
import { formatSSE } from "./articleAIStream";

describe("formatSSE", () => {
  it("serializes an object as an SSE data frame", () => {
    expect(formatSSE({ done: true })).toBe('data: {"done":true}\n\n');
  });
});
