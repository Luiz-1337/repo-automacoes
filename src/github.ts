import { Octokit } from "@octokit/rest";

export type PullRequestContext = {
    owner: string;
    repo: string;
    prNumber: number;
};

export type PullRequestData = {
    pr: Awaited<ReturnType<Octokit["pulls"]["get"]>>["data"];
    commits: Awaited<ReturnType<Octokit["pulls"]["listCommits"]>>["data"];
    files: Awaited<ReturnType<Octokit["pulls"]["listFiles"]>>["data"];
};

const BOT_MARKER = "<!-- pr-task-review-bot -->";

export function createGitHubClient(token: string): Octokit {
    return new Octokit({ auth: token });
}

export async function getPullRequestData(
    octokit: Octokit,
    ctx: PullRequestContext
): Promise<PullRequestData> {
    const pr = await octokit.pulls.get({
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.prNumber,
    });

    const commits = await octokit.paginate(octokit.pulls.listCommits, {
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.prNumber,
        per_page: 100,
    });

    const files = await octokit.paginate(octokit.pulls.listFiles, {
        owner: ctx.owner,
        repo: ctx.repo,
        pull_number: ctx.prNumber,
        per_page: 100,
    });

    return {
        pr: pr.data,
        commits,
        files,
    };
}

export async function upsertIssueComment(
    octokit: Octokit,
    ctx: PullRequestContext,
    body: string
): Promise<void> {
    const comments = await octokit.paginate(octokit.issues.listComments, {
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.prNumber,
        per_page: 100,
    });

    const fullBody = `${BOT_MARKER}\n${body}`;
    const existing = comments.find((comment) => comment.body?.includes(BOT_MARKER));

    if (existing) {
        await octokit.issues.updateComment({
            owner: ctx.owner,
            repo: ctx.repo,
            comment_id: existing.id,
            body: fullBody,
        });
        return;
    }

    await octokit.issues.createComment({
        owner: ctx.owner,
        repo: ctx.repo,
        issue_number: ctx.prNumber,
        body: fullBody,
    });
}

export function parseRepository(fullRepository: string): { owner: string; repo: string } {
    const [owner, repo] = fullRepository.split("/");
    if (!owner || !repo) {
        throw new Error(`Invalid GitHub repository format: ${fullRepository}`);
    }
    return { owner, repo };
}

export function extractAbIds(text: string): number[] {
    const matches = [...text.matchAll(/\bAB#(\d+)\b/gi)];
    return [...new Set(matches.map((m) => Number(m[1])))];
}

export function buildTextPool(input: {
    prTitle?: string | null;
    prBody?: string | null;
    commitMessages: string[];
}): string {
    return [input.prTitle ?? "", input.prBody ?? "", ...input.commitMessages].join("\n");
}
