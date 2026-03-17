/**
 * Minimal Azure DevOps work item shape used by the review pipeline.
 */
export type AzureWorkItem = {
    id: number;
    url: string;
    fields: Record<string, unknown>;
};

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
 * Fetches a work item from Azure DevOps Work Item Tracking API.
 */
export async function getWorkItem(id: number): Promise<AzureWorkItem> {
    const org = required("AZDO_ORG");
    const project = required("AZDO_PROJECT");
    const pat = required("AZDO_PAT");

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
        throw new Error(`Azure DevOps request failed (${response.status}): ${body}`);
    }

    return (await response.json()) as AzureWorkItem;
}

/**
 * Returns a work item field as string, using a fallback for nullish values.
 */
export function getField(workItem: AzureWorkItem, fieldName: string, fallback = ""): string {
    const value = workItem.fields?.[fieldName];
    if (value === undefined || value === null) return fallback;
    return String(value);
}
