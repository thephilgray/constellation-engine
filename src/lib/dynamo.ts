import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { Resource } from "sst";
import type { ConstellationRecord } from "./schemas";

const dbClient = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(dbClient);

const TABLE_NAME = Resource.UnifiedLake.name;

/**
 * Saves a ConstellationRecord to the UnifiedLake DynamoDB table.
 * @param record The record to save.
 */
export async function saveRecord(record: ConstellationRecord): Promise<void> {
  const command = new PutCommand({
    TableName: TABLE_NAME,
    Item: record,
  });

  try {
    await docClient.send(command);
    console.log("Successfully saved record to DynamoDB:", record.PK, record.SK);
  } catch (error) {
    console.error("Error saving record to DynamoDB:", error);
    throw new Error("Could not save record to DynamoDB.");
  }
}

/**
 * Retrieves a specific record from the UnifiedLake table.
 * @param pk The Partition Key (PK) of the record.
 * @param sk The Sort Key (SK) of the record.
 * @returns The retrieved record, or null if not found.
 */
export async function getRecord(pk: string, sk: string): Promise<ConstellationRecord | null> {
    const command = new GetCommand({
        TableName: TABLE_NAME,
        Key: {
            PK: pk,
            SK: sk,
        },
    });

    try {
        const { Item } = await docClient.send(command);
        return (Item as ConstellationRecord) || null;
    } catch (error) {
        console.error("Error retrieving record from DynamoDB:", error);
        throw new Error("Could not retrieve record from DynamoDB.");
    }
}

/**
 * Queries for records based on the Partition Key.
 * @param pk The Partition Key (PK) to query for.
 * @returns An array of matching records.
 */
export async function queryByPK(pk: string): Promise<ConstellationRecord[]> {
    const command = new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: {
            ":pk": pk,
        },
    });

    try {
        const { Items } = await docClient.send(command);
        return (Items as ConstellationRecord[]) || [];
    } catch (error) {
        console.error("Error querying DynamoDB by PK:", error);
        throw new Error("Could not query records from DynamoDB.");
    }
}
