import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { Resource } from "sst";

const sfn = new SFNClient({});

export async function handler(): Promise<{ statusCode: number; body: string }> {
  try {
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
