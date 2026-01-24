import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { Resource } from "sst";
import { getFile } from "../utils";

// Map "friendly" keys to actual file paths
const DASHBOARD_FILES: Record<string, string> = {
    "life_log": "00_Life_Log.md",
    "idea_garden": "00_Idea_Garden.md",
    "story_bible": "00_Story_Bible.md",
    "song_seeds": "00_Song_Seeds.md",
    "dream_analysis": "00_Dream_Journal_Analysis.md",
    "reading_list": "00_Book_Recommendations.md"
};

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    try {
        // Authentication Check
        const userId = event.requestContext.authorizer?.jwt?.claims?.sub;
        if (!userId) {
             return { statusCode: 401, body: JSON.stringify({ message: "Unauthorized" }) };
        }

        const type = event.queryStringParameters?.type;

        if (!type || !DASHBOARD_FILES[type]) {
            return { 
                statusCode: 400, 
                body: JSON.stringify({ 
                    message: "Invalid dashboard type. Available types: " + Object.keys(DASHBOARD_FILES).join(", ") 
                }) 
            };
        }

        const filePath = DASHBOARD_FILES[type];
        
        console.log(`Fetching dashboard: ${type} -> ${filePath}`);
        
        try {
            const file = await getFile(filePath);
            return {
                statusCode: 200,
                body: JSON.stringify({
                    type,
                    content: file.content
                })
            };
        } catch (error: any) {
            console.error(`Error fetching file ${filePath}:`, error);
            if (error.status === 404) {
                 return {
                    statusCode: 200,
                    body: JSON.stringify({
                        type,
                        content: "# Dashboard Not Found\n\nThis dashboard has not been created yet. Try running the associated agent command first!"
                    })
                };
            }
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
