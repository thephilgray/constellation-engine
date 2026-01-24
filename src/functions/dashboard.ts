import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getRecord } from "../lib/dynamo";

const ALLOWED_DASHBOARDS = [
    "life_log",
    "idea_garden",
    "story_bible",
    "song_seeds",
    "dream_analysis",
    "reading_list"
];

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        // Authentication Check
        const userId = (event.requestContext as any).authorizer?.jwt?.claims?.sub;
        if (!userId) {
             return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
        }

        const type = event.queryStringParameters?.type;

        if (!type || !ALLOWED_DASHBOARDS.includes(type)) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ 
                    message: "Invalid dashboard type. Available types: " + ALLOWED_DASHBOARDS.join(", ") 
                }) 
            };
        }

        const pk = `DASHBOARD#${type}`;
        const sk = "STATE";
        
        console.log(`Fetching dashboard from DynamoDB: ${pk} ${sk}`);
        
        try {
            const record = await getRecord(pk, sk);
            
            if (!record) {
                 return {
                    statusCode: 200, // Keep 200 as per previous behavior for "Not Found" content
                    body: JSON.stringify({
                        type,
                        content: "# Dashboard Not Found\n\nThis dashboard has not been created yet. Run the associated agent to generate it."
                    })
                };
            }

            return {
                statusCode: 200,
                body: JSON.stringify({
                    type,
                    content: record.content
                })
            };
        } catch (error: any) {
            console.error(`Error fetching dashboard ${pk}:`, error);
            throw error;
        }

    } catch (error: any) {
        console.error("Dashboard Handler Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ message: "Internal Server Error", error: error.message })
        };
    }
}