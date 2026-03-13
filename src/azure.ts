export type AzureWorkItem = {
    id: number;
    url: string;
    fields: Record<string, unknown>;
};

function getRequiredEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export async function getWorkItem(id: number): Promise<AzureWorkItem> {
    const org = getRequiredEnv("AZDO_ORG");
    const project = getRequiredEnv("AZDO_PROJECT");
    const pat = getRequiredEnv("AZDO_PAT");

    const url =
        `https://dev.azure.com/${encodeURIComponent(org)}/` +
        `${encodeURIComponent(project)}/_apis/wit/workitems/${id}` +
        `?$expand=Fields&api-version=7.1`;

    const auth = Buffer.from(`:${pat}`).toString("base64");

    const response = await fetch(url, {
        method: "GET",
        headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
        },
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Azure DevOps work item request failed (${response.status}): ${body}`);
    }

    return (await response.json()) as AzureWorkItem;
}

export function getWorkItemField<T = string>(
    workItem: AzureWorkItem,
    fieldName: string,
    fallback = ""
): T | string {
    const value = workItem.fields?.[fieldName];
    if (value === undefined || value === null) {
        return fallback;
    }
    return value as T;
}
