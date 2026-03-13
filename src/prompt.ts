import type { AzureWorkItem } from "./azure.js";
import { getWorkItemField } from "./azure.js";

type PromptInput = {
    workItem: AzureWorkItem;
    pr: {
        title: string;
        body?: string | null;
        additions: number;
        deletions: number;
        changed_files: number;
        html_url: string;
    };
    commits: Array<{
        sha: string;
        message: string;
    }>;
    files: Array<{
        filename: string;
        status: string;
        additions?: number;
        deletions?: number;
        changes?: number;
        patch?: string;
    }>;
};

function sanitize(text: string, maxLength: number): string {
    const normalized = text.replace(/\r/g, "").trim();
    if (normalized.length <= maxLength) {
        return normalized;
    }
    return `${normalized.slice(0, maxLength)}\n...[truncado]`;
}

export function buildReviewPrompt(input: PromptInput): string {
    const title = String(getWorkItemField(input.workItem, "System.Title", ""));
    const description = String(getWorkItemField(input.workItem, "System.Description", ""));
    const acceptance = String(
        getWorkItemField(input.workItem, "Microsoft.VSTS.Common.AcceptanceCriteria", "")
    );
    const workItemType = String(getWorkItemField(input.workItem, "System.WorkItemType", ""));
    const state = String(getWorkItemField(input.workItem, "System.State", ""));

    const commitSection = input.commits
        .map((commit) => `- ${commit.sha.slice(0, 8)} ${commit.message}`)
        .join("\n");

    const filesSection = input.files
        .slice(0, 50)
        .map((file) => {
            const patch = file.patch ? sanitize(file.patch, 5000) : "[sem patch disponível]";
            return [
                `ARQUIVO: ${file.filename}`,
                `STATUS: ${file.status}`,
                `MUDANÇAS: +${file.additions ?? 0} / -${file.deletions ?? 0}`,
                "PATCH:",
                patch,
            ].join("\n");
        })
        .join("\n\n");

    return `
Você é um revisor técnico de Pull Request.

Objetivo:
avaliar se o PR parece coerente com a task do Azure DevOps e apontar lacunas, riscos e possíveis itens faltantes.

Regras:
- Responda em português do Brasil.
- Seja objetivo.
- Não elogie sem necessidade.
- Se houver incerteza, diga explicitamente.
- Não invente comportamento que não esteja visível na task ou no diff.

TASK DO AZURE DEVOPS
- ID: ${input.workItem.id}
- Tipo: ${workItemType}
- Estado: ${state}
- Título: ${title}

DESCRIÇÃO DA TASK
${sanitize(description, 12000)}

CRITÉRIOS DE ACEITE
${sanitize(acceptance, 8000)}

PULL REQUEST
- Título: ${input.pr.title}
- URL: ${input.pr.html_url}
- Arquivos alterados: ${input.pr.changed_files}
- Linhas adicionadas: ${input.pr.additions}
- Linhas removidas: ${input.pr.deletions}

DESCRIÇÃO DO PR
${sanitize(input.pr.body ?? "", 8000)}

COMMITS
${commitSection || "[sem commits]"}

ARQUIVOS E PATCHES
${filesSection || "[sem arquivos]"}

Quero a resposta no formato abaixo:

## Resumo
- alinhamento com a task: alto | médio | baixo
- cobertura aparente: completa | parcial | inconsistente

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
