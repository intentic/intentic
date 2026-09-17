import { writeFile } from "node:fs/promises";
import { type DesiredStateGraph, secretRef, type SecretSource } from "@intentic/graph";
import { renderTemplate } from "../lib/templates.js";

// User-facing platform services with an admin login; anything with a public `url` output is a URL-only app.
const SERVICE_LABELS: Readonly<Record<string, string>> = {
    forgejo: "Forgejo (git)",
    komodo: "Komodo (deploys)",
    signoz: "SignOz (observability)",
    outline: "Outline (wiki)",
    paperless: "Paperless-ngx (documents)",
    openproject: "OpenProject (projects)",
    invoiceninja: "Invoice Ninja (invoicing)",
    infisical: "Infisical (secrets)",
};

export interface AccessEntry {
    readonly id: string;
    readonly label: string;
    readonly url: string;
    readonly username?: string;
    // Where the login password lives, by reference. No surface reads a value from here: the summary names the store,
    // the committed access.md names the ref, and the web reveals through its own gate.
    readonly password?: { readonly source: SecretSource; readonly key: string };
}

// Where the user logs into what they provisioned: each service (login) and app (URL only), from the artifact's
// inputs and apply outputs.
export const collectAccess = (
    graph: DesiredStateGraph,
    outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): AccessEntry[] => {
    const entries: AccessEntry[] = [];
    for (const node of Object.values(graph.resources)) {
        if (node.type !== "deployment" && SERVICE_LABELS[node.type] === undefined) {
            continue;
        }
        const url = outputs[node.id]?.["url"];
        if (typeof url !== "string") {
            continue;
        }
        const username = node.inputs["adminUser"];
        const ref = secretRef(node.inputs["adminPassword"]);
        const password = ref === undefined ? undefined : { source: ref.source, key: ref.key };
        entries.push({
            id: node.id,
            label: SERVICE_LABELS[node.type] ?? node.id,
            url,
            ...(typeof username === "string" ? { username } : {}),
            ...(password !== undefined ? { password } : {}),
        });
    }
    return entries;
};

// Where the password is, never the password. Printing the value was self-defeating: apply hands every resolved secret
// to its own redactor, so the one line meant to carry it rendered `«redacted»`, which reads as a bug rather than as a
// policy. The same stdout is teed into a run log on disk, which is no place for an admin password either.
const summaryPassword = (password: AccessEntry["password"]): string => {
    if (password === undefined) {
        return "";
    }
    return password.source === "generated" ? `   password: ${password.key} in .secrets.json` : `   password: $${password.key}`;
};

export const formatAccessSummary = (entries: readonly AccessEntry[]): string => {
    const lines = ["", "Access:"];
    for (const entry of entries) {
        lines.push(`  ${entry.label}  ${entry.url}`);
        if (entry.username !== undefined) {
            lines.push(`    user: ${entry.username}${summaryPassword(entry.password)}`);
        }
    }
    return lines.join("\n");
};

// access.md is committed with the desired-state repo, so it stays value-free: generated passwords point to the
// gitignored store, env passwords show the `$KEY` reference.
const markdownPassword = (password: AccessEntry["password"]): string => {
    if (password === undefined) {
        return "";
    }
    return password.source === "generated" ? "generated (see `.secrets.json`)" : `\`$${password.key}\``;
};

export const writeAccessFile = async (path: string, entries: readonly AccessEntry[]): Promise<void> => {
    const services = entries
        .filter((entry) => entry.username !== undefined)
        .map((entry) => ({ label: entry.label, url: entry.url, username: entry.username, password: markdownPassword(entry.password) }));
    const apps = entries.filter((entry) => entry.username === undefined).map((entry) => ({ id: entry.id, url: entry.url }));
    await writeFile(path, renderTemplate("access.md", { services, apps }));
};
