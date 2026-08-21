import { writeFile } from "node:fs/promises";
import { type DesiredStateGraph, secretRef, type SecretSource } from "@intentic/graph";
import { renderTemplate } from "../lib/templates.js";

// The user-facing platform services that carry an admin login, mapped to a human label. Anything else with
// a public `url` output (i.e. a deployment) is surfaced as a URL-only app environment.
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
    // How the login password is provided. `value` is filled only for generated secrets (intentic owns them,
    // so the user must be told); env secrets keep just the key, shown as a `$KEY` reference.
    readonly password?: { readonly source: SecretSource; readonly key: string; readonly value?: string };
}

// Where the user logs into what they just provisioned: each platform service (with login) and each app
// environment (URL only), derived from the artifact's inputs and the apply outputs already in hand. `env`
// supplies the resolved value for generated passwords (intentic generated them, so it reports them).
export const collectAccess = (
    graph: DesiredStateGraph,
    outputs: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
    env: Readonly<Record<string, string | undefined>>,
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
        const value = ref?.source === "generated" ? env[ref.key] : undefined;
        const password = ref === undefined ? undefined : { source: ref.source, key: ref.key, ...(value !== undefined ? { value } : {}) };
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

// stdout: generated passwords show the actual value (intentic picked it), env passwords a `$KEY` reference.
const summaryPassword = (password: AccessEntry["password"]): string => {
    if (password === undefined) {
        return "";
    }
    if (password.source === "generated") {
        return password.value !== undefined
            ? `   password: ${password.value}  (saved in .secrets.json)`
            : "   password: (generated, see .secrets.json)";
    }
    return `   password: $${password.key}`;
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

// access.md is COMMITTED with the desired-state repo, so it stays value-free: generated passwords point to
// the gitignored store, env passwords show the `$KEY` reference.
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
