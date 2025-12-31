
import { Octokit } from "@octokit/rest";
import { Resource } from "sst";

const octokit = new Octokit({ auth: Resource.GITHUB_TOKEN.value });
const owner = Resource.GITHUB_OWNER.value;
const repo = Resource.GITHUB_REPO.value;
const recommendationsFile = "BookRecommendations.md";

export const handler = async (event: { markdownContent: string }): Promise<{ success: boolean }> => {
  const { markdownContent } = event;
  if (!markdownContent || markdownContent.includes("No new book recommendations")) {
    console.log("No new content to persist. Skipping update.");
    return { success: true };
  }

  try {
    let existingContent = "";
    let fileSha: string | undefined;

    // 1. Get existing file to prepend content and get its SHA
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: recommendationsFile,
      });

      if ('content' in data && 'sha' in data) {
        existingContent = Buffer.from(data.content, 'base64').toString('utf-8');
        fileSha = data.sha;
      }
    } catch (error: any) {
      if (error.status !== 404) {
        throw error; // Rethrow if it's not a "file not found" error
      }
      // If file doesn't exist, we'll create it. fileSha remains undefined.
      console.log(`${recommendationsFile} not found. A new file will be created.`);
    }

    // 2. Prepend new content
    const newContent = `${markdownContent}\n\n${existingContent}`;
    const newContentBase64 = Buffer.from(newContent).toString('base64');
    const commitMessage = `feat(librarian): Add new book recommendations`;

    // 3. Create or update file
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: recommendationsFile,
      message: commitMessage,
      content: newContentBase64,
      sha: fileSha, // If sha is undefined, this creates a new file. If provided, it updates.
    });

    console.log(`Successfully updated ${recommendationsFile}.`);
    return { success: true };
  } catch (error) {
    console.error(`Failed to persist recommendations to ${recommendationsFile}:`, error);
    throw new Error("Failed to update recommendations file in GitHub.");
  }
};
