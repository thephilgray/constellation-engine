import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    // Authentication: Support both API Key (legacy/server) and Cognito JWT (client)
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    const expectedApiKey = `Bearer ${Resource.INGEST_API_KEY.value}`;
    const isApiKeyValid = authHeader === expectedApiKey;
    const isCognitoValid = !!event.requestContext.authorizer?.jwt;

    if (!isApiKeyValid && !isCognitoValid) {
      return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
    }

    // 1. Parse Input Payload & Get User ID
    const payload = event.body ? JSON.parse(event.body) : {};
    // Extract userId from the Cognito token if available
    const userId = event.requestContext.authorizer?.jwt.claims.sub as string | undefined;
    
    // We will pass the userId to the async worker
    const asyncPayload = { ...payload, userId };

    // 2. Invoke Async Worker
    const command = new InvokeCommand({
      FunctionName: Resource.BiographerAsync.name,
      InvocationType: "Event",
      Payload: JSON.stringify(asyncPayload),
    });

    await lambda.send(command);

    // 3. Return Immediate Response
    return {
      statusCode: 200,
      body: JSON.stringify({ 
        message: payload.content 
            ? "Entry received. The Biographer is analyzing it and will update your Life Log shortly." 
            : "Dashboard refresh requested. The Biographer is polishing your Life Log now.",
        // No immediate analysis returned, as it's being generated in the background.
        analysis: "Processing in background..." 
      }),
    };
  } catch (error: any) {
    console.error("Biographer Dispatcher Error:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: "An error occurred.", error: error.message }),
    };
  }
}
