import { describe, it, expect } from "vitest";
import { bucketBoard } from "./listHandoffs";
import type { PublicationRecord } from "./types";

describe("bucketBoard", () => {
  const items: PublicationRecord[] = [
    {
      repoName: "forge/sigil",
      status: "AWAITING_HANDOFF",
      repoUrl: "https://github.com/forge/sigil",
      taskToken: "tok-1",
      discoveredAt: "2026-06-15T00:00:00.000Z",
    },
    {
      repoName: "vercel/next.js",
      status: "PUBLISHED",
      title: "Inside Next.js",
      publishedAt: "2026-06-15T01:00:00.000Z",
    },
  ];

  it("routes AWAITING_HANDOFF items to readyForDev with their task token", () => {
    const board = bucketBoard(items);
    expect(board.readyForDev).toHaveLength(1);
    expect(board.readyForDev[0].repoName).toBe("forge/sigil");
    expect(board.readyForDev[0].taskToken).toBe("tok-1");
  });

  it("routes PUBLISHED items to inReview without exposing a task token", () => {
    const board = bucketBoard(items);
    expect(board.inReview).toHaveLength(1);
    expect(board.inReview[0].repoName).toBe("vercel/next.js");
    expect(board.inReview[0].title).toBe("Inside Next.js");
    expect(board.inReview[0]).not.toHaveProperty("taskToken");
  });

  it("ignores unknown statuses", () => {
    const board = bucketBoard([
      { repoName: "x/y", status: "WEIRD" as any },
    ]);
    expect(board.readyForDev).toHaveLength(0);
    expect(board.inReview).toHaveLength(0);
  });
});
