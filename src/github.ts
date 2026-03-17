import { Octokit } from "@octokit/rest";

/**
 * Identifies a pull request within a repository.
 */
export type PullRequestContext = {
    owner: string;
    repo: string;
    prNumber: number;
};

/**
 * Normalized subset of changed file metadata returned by GitHub.
 */
export type FileSummary = {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    changes: number;
    patch?: string;
};

const BOT_MARKER = "<!-- pr-task-review-bot -->";

/**
 * Creates an authenticated GitHub API client.
 */
export function createGitHubClient(token: string): Octokit {
    return new Octokit({ auth: token });
}

/**
 * Parses `owner/repo` format and validates both parts.
 */
export function parseRepository(fullRepository: string): { owner: string; repo: string } {
    const [owner, repo] = fullRepository.split("/");
    if (!owner || !repo) {
        throw new Error(`Invalid repository format: ${fullRepository}`);
    }
    return { owner, repo };
}

/**
 * Extracts unique AB# identifiers from arbitrary text content.
 */
export function extractAbIds(text: string): number[] {
    const matches = [...text.matchAll(/\bAB#(\d+)\b/gi)];
    return [...new Set(matches.map((m) => Number(m[1])))];
}

/**
 * Aggregates textual PR context used for AB# detection.
 */
export function buildTextPool(input: {
    prTitle?: string | null;
    prBody?: string | null;
    commitMessages: string[];
}): string {
    return [input.prTitle ?? "", input.prBody ?? "", ...input.commitMessages].join("\n");
}

/**
 * Loads PR metadata, commits, and changed files from GitHub.
 */
export async function getPullRequestData(octokit: Octokit, ctx: PullRequestContext) {
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
        files: files.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions ?? 0,
            deletions: file.deletions ?? 0,
            changes: file.changes ?? 0,
            patch: file.patch,
        })) as FileSummary[],
    };
}

/**
 * Creates or updates the bot's PR comment using a stable marker.
 */
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
