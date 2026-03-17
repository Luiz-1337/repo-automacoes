import type { AzureWorkItem } from "./azure.js";
import type { FileSummary } from "./github.js";
import { getField } from "./azure.js";

/**
 * Normalizes, trims, and truncates large text blocks for prompt safety.
 */
function clean(text: string, maxLength: number): string {
    const normalized = text.replace(/\r/g, "").trim();
    if (!normalized) return "[empty]";
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}\n...[truncated]`;
}

/**
 * Infers the likely impacted area from changed file extensions and paths.
 */
function detectArea(files: FileSummary[]): string {
    const names = files.map((f) => f.filename.toLowerCase());

    const hasFrontend = names.some((n) =>
        [".tsx", ".ts", ".jsx", ".js", ".css", ".scss"].some((ext) => n.endsWith(ext))
    );
    const hasCSharp = names.some((n) => n.endsWith(".cs"));
    const hasCpp = names.some((n) =>
        [".cpp", ".cc", ".cxx", ".h", ".hpp"].some((ext) => n.endsWith(ext))
    );
    const hasInfra = names.some(
        (n) =>
            n.endsWith(".yml") ||
            n.endsWith(".yaml") ||
            n.includes("dockerfile") ||
            n.startsWith(".github/")
    );

    const areas: string[] = [];
    if (hasFrontend) areas.push("frontend");
    if (hasCSharp) areas.push("backend C#");
    if (hasCpp) areas.push("C++");
    if (hasInfra) areas.push("infra");

    if (areas.length === 0) return "not identified";
    if (areas.length === 1) return areas[0];
    return "mixed";
}

/**
 * Builds the LLM review prompt from Azure task context and GitHub PR metadata.
 */
export function buildReviewPrompt(input: {
    workItem?: AzureWorkItem;
    pr: {
        title: string;
        body?: string | null;
        html_url: string;
        additions: number;
        deletions: number;
        changed_files: number;
    };
    commits: Array<{ sha: string; message: string }>;
    files: FileSummary[];
}): string {
    const hasWorkItem = Boolean(input.workItem);
    const area = detectArea(input.files);

    const taskSection = hasWorkItem
        ? `
TASK CONTEXT (Azure DevOps)
- ID: ${input.workItem!.id}
- Type: ${getField(input.workItem!, "System.WorkItemType")}
- State: ${getField(input.workItem!, "System.State")}
- Title: ${getField(input.workItem!, "System.Title")}

TASK DESCRIPTION
${clean(getField(input.workItem!, "System.Description"), 12000)}

ACCEPTANCE CRITERIA
${clean(getField(input.workItem!, "Microsoft.VSTS.Common.AcceptanceCriteria"), 10000)}
`
        : `
TASK CONTEXT (Azure DevOps)
- No task was provided in this PR (no AB#).
- Azure DevOps was not queried.
`;

    const objectiveInstruction = hasWorkItem
        ? "Your task is to compare the Azure DevOps task with the GitHub PR and assess whether the implementation appears coherent, sufficient, and safe."
        : "Your task is to evaluate the PR using only code changes and available textual context (title, description, and commits), judging technical coherence, apparent coverage, and risks.";

    const noHallucinationRule = hasWorkItem
        ? "- Do not invent behavior that is not visible in the task or in the diff."
        : "- Do not invent behavior that is not visible in the diff or in the PR context.";

    const summaryAlignmentLabel = hasWorkItem
        ? "alignment with the task"
        : "alignment with the apparent PR objective";

    const commitSection =
        input.commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.message}`).join("\n") || "[no commits]";

    const fileSection =
        input.files
            .slice(0, 40)
            .map((f) => {
                const patch = clean(f.patch ?? "[no patch available]", 4500);
                return [
                    `FILE: ${f.filename}`,
                    `STATUS: ${f.status}`,
                    `CHANGES: +${f.additions} / -${f.deletions}`,
                    "PATCH:",
                    patch,
                ].join("\n");
            })
            .join("\n\n") || "[no files]";

    return `
You are a technical pull request reviewer in a corporate engineering environment.

${objectiveInstruction}

Rules:
- Respond in English.
- Be objective and critical.
- Do not add unnecessary praise.
- If uncertainty exists, state it explicitly.
${noHallucinationRule}
- Consider impact on backend, frontend, API contracts, tests, and integration.
- Pay attention to risks of partial implementation.
- At the end, choose exactly one verdict: PASS, WARN, or FAIL.

${taskSection}

PR CONTEXT
- URL: ${input.pr.html_url}
- Title: ${input.pr.title}
- Likely impacted area: ${area}
- Changed files: ${input.pr.changed_files}
- Added lines: ${input.pr.additions}
- Removed lines: ${input.pr.deletions}

PR DESCRIPTION
${clean(input.pr.body ?? "", 6000)}

COMMITS
${commitSection}

FILES AND PATCHES
${fileSection}

Required response format:

## Summary
- ${summaryAlignmentLabel}: high | medium | low
- apparent coverage: complete | partial | inconsistent
- overall risk: low | medium | high

## What Makes Sense
- short bullets

## Gaps / What Might Be Missing
- short bullets

## Technical and Functional Risks
- short bullets

## Verdict
PASS | WARN 

## Final Note
- 1 short paragraph justifying the verdict
`.trim();
}
