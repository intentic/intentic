import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ENV_FILE, SECRETS_FILE } from "@intentic/scaffold";
import type { SecretVault } from "../capabilities/secret-vault.js";

// Every credential value under a stable name (a `{{secret:name}}` token): masking replaces a value with its reference,
// resolution replaces it back only where it leaves. Unions three stores (env, deploy-generated, capability vault); env
// wins a name collision. Read fresh each call, never cached, so a mid-turn credential masks from the very next tool
// result.

export interface NamedSecret {
    // The reference name: an env key (`CLOUDFLARE_API_TOKEN`) or `<capability>/<field>` (`reddit/password`).
    readonly name: string;
    readonly value: string;
    readonly source: "env" | "generated" | "capability";
}

// Double braces, not a value-lookalike, since substitution must be exact-match; a key-shaped token invites a model to
// "fix" it or reason about its length.
export const secretReference = (name: string): string => `{{secret:${name}}}`;

// Matches the name alphabet the three stores produce: env keys, capability ids, fields, and the joining `/`.
const REFERENCE = /\{\{secret:([A-Za-z0-9_./-]+)\}\}/g;

export interface ResolvedReferences {
    readonly text: string;
    // Names resolved, in order of first appearance, what the audit trail records.
    readonly used: readonly string[];
    // Names shaped like a reference but unmatched; callers fail hard rather than leave a literal token in config.
    readonly unknown: readonly string[];
}

// Replaces every known `{{secret:name}}` token with its value, textually, so it survives wherever it sits (a quoted
// JSON body, an env assignment, a URL) that an env-var indirection would not.
export const resolveSecretReferences = (text: string, secrets: readonly NamedSecret[]): ResolvedReferences => {
    const byName = new Map(secrets.map((secret) => [secret.name, secret.value]));
    const used: string[] = [];
    const unknown: string[] = [];
    const resolved = text.replace(REFERENCE, (token, name: string) => {
        const value = byName.get(name);
        if (value === undefined) {
            if (!unknown.includes(name)) {
                unknown.push(name);
            }
            return token;
        }
        if (!used.includes(name)) {
            used.push(name);
        }
        return value;
    });
    return { text: resolved, used, unknown };
};

// The forms a value can take by the time a reader sees it; masking matches all of them, not just the raw string.
// - JSON-escaped: quotes, backslashes, newlines serialized in a logged payload
// - percent-encoded: URL query or form body
// Alphanumeric values encode to themselves and are skipped.
export const surfaceForms = (value: string): readonly string[] => {
    const forms = [value];
    // JSON.stringify of a string is always a quoted string; the slice is its escaped body.
    const jsonEscaped = JSON.stringify(value).slice(1, -1);
    if (jsonEscaped !== value) {
        forms.push(jsonEscaped);
    }
    try {
        const encoded = encodeURIComponent(value);
        if (encoded !== value) {
            forms.push(encoded);
        }
    } catch {
        // A lone surrogate makes encodeURIComponent throw; nothing to register since it can't reach a reader that way.
    }
    return forms;
};

// Cheap pre-check for any reference-shaped token, so callers skip the registry read on the common case of no secret.
export const hasSecretReferences = (text: string): boolean => {
    REFERENCE.lastIndex = 0;
    return REFERENCE.test(text);
};

const readJson = async (path: string): Promise<Record<string, unknown>> => {
    try {
        return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    } catch {
        return {};
    }
};

export const secretRegistryOf = (vault: SecretVault, desiredStateRepo: () => string) => async (): Promise<readonly NamedSecret[]> => {
    const [vaulted, envRaw, generated] = await Promise.all([
        vault.all().catch(() => ({})),
        readFile(join(desiredStateRepo(), ENV_FILE), "utf8").catch(() => ""),
        readJson(join(desiredStateRepo(), SECRETS_FILE)),
    ]);
    const byName = new Map<string, NamedSecret>();
    const add = (name: string, value: unknown, source: NamedSecret["source"]): void => {
        if (typeof value === "string" && value !== "" && !byName.has(name)) {
            byName.set(name, { name, value, source });
        }
    };
    // parseEnv's Dict has only string values, which is all this reads.
    for (const [key, value] of Object.entries(parseEnv(envRaw) as Record<string, string>)) {
        add(key, value, "env");
    }
    for (const [key, value] of Object.entries(generated)) {
        add(key, value, "generated");
    }
    for (const [id, fields] of Object.entries(vaulted)) {
        for (const [field, value] of Object.entries(fields)) {
            add(`${id}/${field}`, value, "capability");
        }
    }
    return [...byName.values()];
};
