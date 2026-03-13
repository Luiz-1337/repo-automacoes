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

function getRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function buildNoTaskComment(): string {
    return `
## Revisão automática da task

Não encontrei nenhum identificador \`AB#123\` no título, descrição ou commits deste PR.

Para esta automação funcionar, inclua o ID da task do Azure DevOps no padrão \`AB#123\`.
`.trim();
}

function buildErrorComment(message: string): string {
    return `
## Revisão automática da task

A validação automática encontrou um erro:

\`\`\`
${message}
\`\`\`
`.trim();
}

async function main(): Promise<void> {
    const githubToken = getRequiredEnv("GITHUB_TOKEN");
    const repository = getRequiredEnv("GITHUB_REPOSITORY");
    const prNumber = Number(getRequiredEnv("PR_NUMBER"));
    const openAiApiKey = getRequiredEnv("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-5.2";

    if (Number.isNaN(prNumber)) {
        throw new Error(`Invalid PR_NUMBER: ${process.env.PR_NUMBER}`);
    }

    const { owner, repo } = parseRepository(repository);
    const ctx = { owner, repo, prNumber };

    const octokit = createGitHubClient(githubToken);
    const prData = await getPullRequestData(octokit, ctx);

    const textPool = buildTextPool({
        prTitle: prData.pr.title,
        prBody: prData.pr.body,
        commitMessages: prData.commits.map((commit) => commit.commit.message ?? ""),
    });

    const abIds = extractAbIds(textPool);

    if (abIds.length === 0) {
        await upsertIssueComment(octokit, ctx, buildNoTaskComment());
        return;
    }

    const workItemId = abIds[0];
    const workItem = await getWorkItem(workItemId);

    const prompt = buildReviewPrompt({
        workItem,
        pr: {
            title: prData.pr.title,
            body: prData.pr.body,
            additions: prData.pr.additions,
            deletions: prData.pr.deletions,
            changed_files: prData.pr.changed_files,
            html_url: prData.pr.html_url,
        },
        commits: prData.commits.map((commit) => ({
            sha: commit.sha,
            message: commit.commit.message ?? "",
        })),
        files: prData.files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch,
        })),
    });

    const client = new OpenAI({ apiKey: openAiApiKey });

    const response = await client.responses.create({
        model,
        input: prompt,
    });

    const reviewText = response.output_text?.trim() || "Não foi possível gerar análise textual.";

    const commentBody = `
## Revisão automática da task

Task encontrada: \`AB#${workItemId}\`

${reviewText}
`.trim();

    await upsertIssueComment(octokit, ctx, commentBody);
}

main().catch(async (error) => {
    const githubToken = process.env.GITHUB_TOKEN;
    const repository = process.env.GITHUB_REPOSITORY;
    const prNumberRaw = process.env.PR_NUMBER;

    console.error(error);

    if (!githubToken || !repository || !prNumberRaw) {
        process.exit(1);
    }

    try {
        const { owner, repo } = parseRepository(repository);
        const prNumber = Number(prNumberRaw);

        if (Number.isNaN(prNumber)) {
            process.exit(1);
        }

        const octokit = createGitHubClient(githubToken);
        await upsertIssueComment(
            octokit,
            { owner, repo, prNumber },
            buildErrorComment(error instanceof Error ? error.message : String(error))
        );
    } catch (commentError) {
        console.error("Failed to post error comment:", commentError);
    }

    process.exit(1);
});
