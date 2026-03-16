import type { AzureWorkItem } from "./azure.js";
import type { FileSummary } from "./github.js";
import { getField } from "./azure.js";

function clean(text: string, maxLength: number): string {
    const normalized = text.replace(/\r/g, "").trim();
    if (!normalized) return "[vazio]";
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}\n...[truncado]`;
}

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

    if (areas.length === 0) return "não identificada";
    if (areas.length === 1) return areas[0];
    return "mista";
}

export function buildReviewPrompt(input: {
    workItem: AzureWorkItem;
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
    const taskTitle = getField(input.workItem, "System.Title");
    const taskDescription = getField(input.workItem, "System.Description");
    const acceptance = getField(input.workItem, "Microsoft.VSTS.Common.AcceptanceCriteria");
    const taskType = getField(input.workItem, "System.WorkItemType");
    const taskState = getField(input.workItem, "System.State");
    const area = detectArea(input.files);

    const commitSection =
        input.commits.map((c) => `- ${c.sha.slice(0, 8)} ${c.message}`).join("\n") || "[sem commits]";

    const fileSection =
        input.files
            .slice(0, 40)
            .map((f) => {
                const patch = clean(f.patch ?? "[sem patch disponível]", 4500);
                return [
                    `ARQUIVO: ${f.filename}`,
                    `STATUS: ${f.status}`,
                    `MUDANÇAS: +${f.additions} / -${f.deletions}`,
                    `PATCH:`,
                    patch,
                ].join("\n");
            })
            .join("\n\n") || "[sem arquivos]";

    return `
Você é um revisor técnico de pull requests em um ambiente corporativo.

Sua tarefa é comparar a task do Azure DevOps com o PR do GitHub e avaliar se a implementação parece coerente, suficiente e segura.

Regras:
- Responda em português do Brasil.
- Seja objetivo e crítico.
- Não elogie sem necessidade.
- Se houver incerteza, diga explicitamente.
- Não invente comportamento que não esteja visível na task ou no diff.
- Considere impacto em backend, frontend, contrato, testes e integração.
- Dê atenção a riscos de implementação parcial.
- Ao final, escolha exatamente um veredito: PASSA, ALERTA ou FALHA.

CONTEXTO DA TASK (Azure DevOps)
- ID: ${input.workItem.id}
- Tipo: ${taskType}
- Estado: ${taskState}
- Título: ${taskTitle}

DESCRIÇÃO DA TASK
${clean(taskDescription, 12000)}

CRITÉRIOS DE ACEITE
${clean(acceptance, 10000)}

CONTEXTO DO PR
- URL: ${input.pr.html_url}
- Título: ${input.pr.title}
- Área provável impactada: ${area}
- Arquivos alterados: ${input.pr.changed_files}
- Linhas adicionadas: ${input.pr.additions}
- Linhas removidas: ${input.pr.deletions}

DESCRIÇÃO DO PR
${clean(input.pr.body ?? "", 6000)}

COMMITS
${commitSection}

ARQUIVOS E PATCHES
${fileSection}

Formato obrigatório da resposta:

## Resumo
- alinhamento com a task: alto | médio | baixo
- cobertura aparente: completa | parcial | inconsistente
- risco geral: baixo | médio | alto

## O que faz sentido
- bullets curtos

## Lacunas / o que pode faltar
- bullets curtos

## Riscos técnicos e funcionais
- bullets curtos

## Veredito
PASSA | ALERTA | FALHA

## Observação final
- 1 parágrafo curto justificando o veredito
`.trim();
}