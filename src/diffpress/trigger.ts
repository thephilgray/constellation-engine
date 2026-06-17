import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { Resource } from "sst";
import { getDiscoveryConfig } from "./lib/config";

const sfn = new SFNClient({});

export async function handler(): Promise<{ statusCode: number; body: string }> {
  try {
    // Engine off/paused → don't start a discovery run (the hourly ingest keeps
    // running on `paused`; only `active` discovers).
    const { engineState } = await getDiscoveryConfig();
    if (engineState !== "active") {
      console.log(`[trigger] engine is ${engineState}; skipping ContentEngine start`);
      return {
        statusCode: 200,
        body: JSON.stringify({ message: `Engine ${engineState}; skipped`, skipped: true }),
      };
    }

    const stateMachineArn = (Resource as unknown as { ContentEngine: { arn: string } }).ContentEngine.arn;
    const res = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn,
        input: "{}",
      })
    );
    console.log("[trigger] started ContentEngine:", res.executionArn);
    return {
      statusCode: 202,
      body: JSON.stringify({ message: "ContentEngine started", executionArn: res.executionArn }),
    };
  } catch (error) {
    console.error("[trigger] failed to start ContentEngine:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    return { statusCode: 500, body: JSON.stringify({ message: "Failed to start ContentEngine", error: message }) };
  }
}
