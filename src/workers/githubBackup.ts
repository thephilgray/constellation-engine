import type { DynamoDBStreamEvent } from "aws-lambda";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { createOrUpdateFile } from "../utils";
import type { ConstellationRecord } from "../lib/schemas";

export const handler = async (event: DynamoDBStreamEvent) => {
  console.log(`Processing ${event.Records.length} records.`);

  for (const record of event.Records) {
    if (record.eventName === "INSERT" || record.eventName === "MODIFY") {
      if (!record.dynamodb?.NewImage) continue;

      try {
        // Unmarshall DynamoDB JSON format to standard JSON
        const item = unmarshall(record.dynamodb.NewImage as Record<string, AttributeValue>) as ConstellationRecord;

        // Skip backup if flag is set (e.g. during migration)
        if (item.skipBackup) {
            console.log(`Skipping backup for ${item.id} (skipBackup: true)`);
            continue;
        }

        // Only backup entries and dashboards
        if (item.type !== 'Entry' && item.type !== 'Dashboard') continue;

        let filePath = "";
        let fileContent = "";

        if (item.type === 'Dashboard') {
             if (item.id === 'life_log') {
                 filePath = "00_Life_Log.md";
                 fileContent = item.content; // No frontmatter for the main dashboard view
                 console.log(`Updating Dashboard: ${filePath}`);
             } else {
                 console.log(`Skipping unknown dashboard id: ${item.id}`);
                 continue;
             }
        } else {
            // Construct Markdown Content with Frontmatter for Entries
            const frontmatter = [
                "---",
                `id: "${item.id}"`,
                `created_at: "${item.createdAt}"`,
                `original: ${item.isOriginal}`,
                `type: "${item.mediaType}"`,
                item.tags ? `tags: [${item.tags.map(t => `"${t}"`).join(', ')}]` : "",
                item.sourceURL ? `source_url: "${item.sourceURL}"` : "",
                item.sourceTitle ? `source_title: "${item.sourceTitle}"` : "",
                item.sourceAuthor ? `source_author: "${item.sourceAuthor}"` : "",
                "---"
            ].filter(line => line !== "").join("\n");

            fileContent = `${frontmatter}\n\n${item.content}`;

            // Determine File Path
            const year = new Date(item.createdAt).getFullYear();
            const month = String(new Date(item.createdAt).getMonth() + 1).padStart(2, '0');
            const day = String(new Date(item.createdAt).getDate()).padStart(2, '0');
            const filename = `${year}-${month}-${day}_${item.id}.md`;
            
            // Folder structure: Archive/YYYY/MM/filename.md
            filePath = `Archive/${year}/${month}/${filename}`;
            console.log(`Backing up ${item.id} to ${filePath}`);
        }

        await createOrUpdateFile(
          filePath,
          fileContent,
          `backup: ${item.type} ${item.id}`
        );

      } catch (error) {
        console.error("Error processing record:", error);
        // Don't throw, so we don't block other records in the batch (unless strict ordering is required)
      }
    }
  }
};
