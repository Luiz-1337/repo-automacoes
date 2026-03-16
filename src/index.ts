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

function required(name: string): string {
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

Inclua o ID da task do Azure DevOps no padrão \`AB#123\`.
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
    const githubToken = required("GITHUB_TOKEN");
    const repository = required("TARGET_GITHUB_REPOSITORY");
    const prNumber = Number(required("TARGET_PR_NUMBER"));
    const openAiApiKey = required("OPENAI_API_KEY");
    const model = process.env.OPENAI_MODEL || "gpt-5.2";

    if (Number.isNaN(prNumber)) {
        throw new Error(`Invalid TARGET_PR_NUMBER: ${process.env.TARGET_PR_NUMBER}`);
    }

    console.log("Iniciando revisão automática...");
    console.log(`Repo alvo: ${repository}`);
    console.log(`PR alvo: ${prNumber}`);

    const { owner, repo } = parseRepository(repository);
    const ctx = { owner, repo, prNumber };

    const octokit = createGitHubClient(githubToken);
    const prData = await getPullRequestData(octokit, ctx);

    console.log(`PR carregado: ${prData.pr.title}`);

    const textPool = buildTextPool({
        prTitle: prData.pr.title,
        prBody: prData.pr.body,
        commitMessages: prData.commits.map((c) => c.commit.message ?? ""),
    });

    const abIds = extractAbIds(textPool);
    console.log(`AB IDs encontrados: ${abIds.length ? abIds.join(", ") : "nenhum"}`);

    if (abIds.length === 0) {
        await upsertIssueComment(octokit, ctx, buildNoTaskComment());
        console.log("Comentário de ausência de AB# publicado.");
        return;
    }

    const workItemId = abIds[0];
    console.log(`Consultando Azure DevOps para AB#${workItemId}...`);
    const workItem = await getWorkItem(workItemId);

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

    console.log("Chamando OpenAI...");
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
    console.log("Comentário de revisão publicado/atualizado com sucesso.");
}

main().catch(async (error) => {
    console.error(error);

    const githubToken = process.env.GITHUB_TOKEN;
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