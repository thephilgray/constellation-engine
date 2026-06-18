import { markAwaitingHandoff } from "./lib/ledger";
import type { ContentEngineState } from "./types";

interface NotifyHandoffEvent {
  taskToken: string;
  state: ContentEngineState;
}

export async function handler(event: NotifyHandoffEvent): Promise<{ ok: true }> {
  const { taskToken, state } = event;
  const payloadKey = state.enrichment?.key;

  console.log(
    `[notifyHandoff] AWAITING HANDOFF repo=${state.repo.repoName} ` +
      `payloadKey=${payloadKey} taskToken=${taskToken}`
  );

  await markAwaitingHandoff(state.repo.repoName, {
    repoUrl: state.repo.repoUrl,
    taskToken,
    payloadKey,
    handoffPrompt: state.handoffPrompt,
  });

  return { ok: true };
}
