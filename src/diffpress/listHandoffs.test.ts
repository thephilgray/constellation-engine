import { describe, it, expect } from "vitest";
import { bucketBoard } from "./listHandoffs";
import type { PublicationRecord } from "./types";

describe("bucketBoard", () => {
  const items: PublicationRecord[] = [
    {
      repoName: "tau/agentmesh",
      status: "DISCOVERED",
      repoUrl: "https://github.com/tau/agentmesh",
      description: "A message bus for multi-agent systems.",
      stars: 900,
      language: "Go",
      pushedAt: "2026-06-12T00:00:00.000Z",
    },
    {
      repoName: "forge/sigil",
      status: "AWAITING_HANDOFF",
      repoUrl: "https://github.com/forge/sigil",
      taskToken: "tok-1",
      discoveredAt: "2026-06-15T00:00:00.000Z",
    },
    {
      repoName: "cortex/orchard",
      status: "DRAFTING",
      description: "Synthesizing the draft.",
    },
    {
      repoName: "vercel/next.js",
      status: "PUBLISHED",
      title: "Inside Next.js",
      publishedAt: "2026-06-15T01:00:00.000Z",
    },
  ];

  it("routes DISCOVERED items to discovered with their GitHub metadata", () => {
    const board = bucketBoard(items);
    expect(board.discovered).toHaveLength(1);
    expect(board.discovered[0].repoName).toBe("tau/agentmesh");
    expect(board.discovered[0].stars).toBe(900);
    expect(board.discovered[0].language).toBe("Go");
  });

  it("routes AWAITING_HANDOFF items to readyForDev with their task token", () => {
    const board = bucketBoard(items);
    expect(board.readyForDev).toHaveLength(1);
    expect(board.readyForDev[0].taskToken).toBe("tok-1");
  });

  it("routes DRAFTING items to drafting", () => {
    const board = bucketBoard(items);
    expect(board.drafting).toHaveLength(1);
    expect(board.drafting[0].repoName).toBe("cortex/orchard");
  });

  it("routes PUBLISHED items to inReview without exposing a task token", () => {
    const board = bucketBoard(items);
    expect(board.inReview).toHaveLength(1);
    expect(board.inReview[0].title).toBe("Inside Next.js");
    expect(board.inReview[0]).not.toHaveProperty("taskToken");
  });

  it("ignores unknown statuses", () => {
    const board = bucketBoard([{ repoName: "x/y", status: "WEIRD" as any }]);
    expect(board.discovered).toHaveLength(0);
    expect(board.readyForDev).toHaveLength(0);
    expect(board.drafting).toHaveLength(0);
    expect(board.inReview).toHaveLength(0);
  });
});
