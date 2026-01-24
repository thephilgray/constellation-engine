import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: "us-east-1" }));

async function run() {
  try {
    const command = new ScanCommand({
      TableName: Resource.UnifiedLake.name,
      ProjectionExpression: "PK", // Only get the Partition Key
    });

    const response = await dynamo.send(command);
    const uniqueUsers = new Set(response.Items?.map(item => item.PK));

    console.log("Found Users:");
    uniqueUsers.forEach(user => console.log(user));
  } catch (error) {
    console.error("Error listing users:", error);
  }
}

run();
