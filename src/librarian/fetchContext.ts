
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";

const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
const owner = Resource.GITHUB_OWNER.value;
const repo = Resource.GITHUB_REPO.value;
const vaultPath = "_Archive";
const recommendationsFile = "BookRecommendations.md";

async function getRecentWriting(): Promise<string> {
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const since = sevenDaysAgo.toISOString();

    try {
        const commits = await octokit.repos.listCommits({
            owner,
            repo,
            path: vaultPath,
            since,
        });

        if (commits.data.length === 0) {
            return "";
        }

        const fileContents: string[] = [];
        const processedFiles = new Set<string>();

        for (const commit of commits.data) {
            const commitDetails = await octokit.repos.getCommit({
                owner,
                repo,
                ref: commit.sha,
            });

            for (const file of commitDetails.data.files ?? []) {
                if (file.filename && file.filename.endsWith('.md') && !processedFiles.has(file.filename)) {
                    processedFiles.add(file.filename);
                    try {
                        const contentResponse = await octokit.repos.getContent({
                            owner,
                            repo,
                            path: file.filename,
                        });
                        if ('content' in contentResponse.data) {
                            fileContents.push(Buffer.from(contentResponse.data.content, 'base64').toString('utf-8'));
                        }
                    } catch (contentError) {
                        console.warn(`Could not fetch content for ${file.filename}:`, contentError);
                    }
                }
            }
        }
        return fileContents.join("\n\n---\n\n");
    } catch (error) {
        console.error("Error fetching recent writing:", error);
        return ""; // Return empty string on error to not block the workflow
    }
}


async function getPastRecommendations(): Promise<string[]> {
    try {
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: recommendationsFile,
        });

        if (!('content' in data)) {
            return [];
        }

        const content = Buffer.from(data.content, 'base64').toString('utf-8');
        // Simple regex to find markdown headings (e.g., "## Book Title")
        const titles = content.match(/^##\s*(.*)/gm);
        return titles ? titles.map(title => title.replace("## ", "").trim()) : [];

    } catch (error: any) {
        if (error.status === 404) {
            console.log(`${recommendationsFile} not found. Assuming no past recommendations.`);
            return [];
        }
        console.error("Error fetching past recommendations:", error);
        return [];
    }
}

export const handler = async (): Promise<{ recentWriting: string; pastRecsList: string[] }> => {
    const [recentWriting, pastRecsList] = await Promise.all([
        getRecentWriting(),
        getPastRecommendations(),
    ]);

    if (!recentWriting) {
        // If there's no new writing, we can short-circuit the whole process.
        // Step Functions can be configured to handle this, but for now we'll let it continue
        // and the AI will have no context.
        console.log("No recent writing found in the last 7 days.");
    }

    return { recentWriting, pastRecsList };
};
