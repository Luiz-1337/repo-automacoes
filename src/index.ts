import "dotenv/config";
import OpenAI from "openai";
import {
    buildTextPool,
    createGitHubClient,
    extractAbIds,
    getPullRequestData,
    parseRepository,
    upsertIssueComment,
} from "./github.js";
import { getWorkItem } from "./azure.js";
import { buildReviewPrompt } from "./prompt.js";

/**
 * Reads a required environment variable and throws when missing.
 */
function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

/**
 * Builds the fallback PR comment body when the automation fails.
 */
function buildErrorComment(message: string): string {
    return `
## Automated task review

The automated validation found an error:

\`\`\`
${message}
\`\`\`
`.trim();
}

/**
 * Coordinates PR data collection, prompt generation, model call, and PR comment upsert.
 */
async function main(): Promise<void> {
    const githubToken = required("TOKEN_GITHUB");
    const repository = required("TARGET_GITHUB_REPOSITORY");
    const prNumber = Number(required("TARGET_PR_NUMBER"));
    const openAiApiKey = required("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-5.2";

    if (Number.isNaN(prNumber)) {
        throw new Error(`Invalid TARGET_PR_NUMBER: ${process.env.TARGET_PR_NUMBER}`);
    }

    const { owner, repo } = parseRepository(repository);
    const ctx = { owner, repo, prNumber };

    const octokit = createGitHubClient(githubToken);
    const prData = await getPullRequestData(octokit, ctx);

    const textPool = buildTextPool({
        prTitle: prData.pr.title,
        prBody: prData.pr.body,
        commitMessages: prData.commits.map((c) => c.commit.message ?? ""),
    });

    const abIds = extractAbIds(textPool);

    const hasWorkItem = abIds.length > 0;
    let workItemId: number | undefined;

    let workItem: Awaited<ReturnType<typeof getWorkItem>> | undefined;
    if (hasWorkItem) {
        workItemId = abIds[0];
        workItem = await getWorkItem(workItemId);
    }

    const prompt = buildReviewPrompt({
        workItem,
        pr: {
            title: prData.pr.title,
            body: prData.pr.body,
            html_url: prData.pr.html_url,
            additions: prData.pr.additions,
            deletions: prData.pr.deletions,
            changed_files: prData.pr.changed_files,
        },
        commits: prData.commits.map((c) => ({
            sha: c.sha,
            message: c.commit.message ?? "",
        })),
        files: prData.files,
    });

    const client = new OpenAI({ apiKey: openAiApiKey });

    const response = await client.responses.create({
        model,
        input: prompt,
    });

    const reviewText = response.output_text?.trim() || "Unable to generate textual analysis.";

    const header = hasWorkItem
        ? `Task found: \`AB#${workItemId}\``
        : "No AB# was provided in the PR. Review was performed without Azure DevOps task validation.";

    const commentBody = `
## Automated task review

${header}

${reviewText}
`.trim();

    await upsertIssueComment(octokit, ctx, commentBody);
}

main().catch(async (error) => {
    console.error(error);

    const githubToken = process.env.TOKEN_GITHUB;
    const repository = process.env.TARGET_GITHUB_REPOSITORY;
    const prNumberRaw = process.env.TARGET_PR_NUMBER;

    if (!githubToken || !repository || !prNumberRaw) {
        process.exit(1);
    }

    try {
        const { owner, repo } = parseRepository(repository);
        const prNumber = Number(prNumberRaw);

        if (!Number.isNaN(prNumber)) {
            const octokit = createGitHubClient(githubToken);
            await upsertIssueComment(
                octokit,
                { owner, repo, prNumber },
                buildErrorComment(error instanceof Error ? error.message : String(error))
            );
        }
    } catch (commentError) {
        console.error("Failed to post error comment:", commentError);
    }

    process.exit(1);
});
