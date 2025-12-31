
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { Resource } from "sst";

const sfn = new SFNClient({});

export const handler: APIGatewayProxyHandlerV2 = async (event) => {

  if (event.requestContext.http.method !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ message: "Method Not Allowed" }),
    };
  }

  try {
    const stateMachineArn = Resource.DialecticalLibrarian.arn;

    await sfn.send(
      new StartExecutionCommand({
        stateMachineArn,
        input: "{}", // Start with an empty JSON object
      })
    );

    return {
      statusCode: 202,
      body: JSON.stringify({ message: "Dialectical Librarian workflow started." }),
    };
  } catch (error) {
    console.error("Failed to start Step Function execution:", error);
    const errorMessage = error instanceof Error ? error.message : "An unknown error occurred.";
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "Failed to start workflow.", error: errorMessage }),
    };
  }
};
