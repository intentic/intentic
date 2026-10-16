import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { undefinedIfMissing } from "@intentic/base/errors";
import { SECRET_STORES, type SecretStore } from "@intentic/output-cleaners/cleaners";
import { SECRET_REFERENCE } from "@intentic/sandbox-contract/schemas/needs";
import { z } from "zod";
import type { SecretVault, SecretVaultContents } from "../capabilities/credentials/secret-vault.js";
import type { SandboxSecrets } from "./sandbox-secrets.js";

// Every credential value under a stable name (a `{{secret:name}}` token): masking replaces a value with its reference,
// resolution replaces it back only where it leaves. Unions the stores the terminal filter reads (SECRET_STORES: env, the
// sandbox's own, deploy-generated, capability vault, keyring copies, values a keyring released) in that list's order, so
// env wins a name collision. Read fresh each call, never cached, so a mid-turn credential masks from the very next tool
// result. A `device` value is listed to mask and never to resolve (secret-access.ts): each use asks its computer again.

export interface NamedSecret {
    // The reference name: an env key (`CLOUDFLARE_API_TOKEN`) or `<capability>/<field>` (`reddit/password`).
    readonly name: string;
    readonly value: string;
    readonly source: SecretStore["source"];
}

// The reference a value masks to, and the forms a value can take by the time a reader sees it (raw, JSON-escaped,
// percent-encoded), which masking matches all of. The terminal filter's own, so the two lanes cannot disagree about what
// a secret looks like or what it masks to.
export { secretReference, surfaceForms } from "@intentic/output-cleaners/cleaners";

// The /g copy replace needs, built once; the shared pattern stays non-global, so no caller inherits a `lastIndex`.
const REFERENCES = new RegExp(SECRET_REFERENCE.source, "g");

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
    const resolved = text.replace(REFERENCES, (token, name: string) => {
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

// Every name a reference in `text` carries, in order of first appearance, whatever holds it.
export const referencedNames = (text: string): readonly string[] => [...new Set(Array.from(text.matchAll(REFERENCES), (match) => match[1] ?? ""))].filter((name) => name !== "");

// Cheap pre-check for any reference-shaped token, so callers skip the registry read on the common case of no secret.
export const hasSecretReferences = (text: string): boolean => SECRET_REFERENCE.test(text);

// A store the registry could not read; its message names the file and never quotes it, so it may reach a reader.
export class SecretStoreUnreadableError extends Error {
    override name = "SecretStoreUnreadableError";
}

// One store's values, each under the name a reference resolves.
type Entries = readonly (readonly [string, string])[];

// What a deploy generated: {name: value}, a value that is not a string kept out rather than failing the store.
const GeneratedSecretsSchema = z.record(z.string(), z.string().catch(""));

// Only an absent store holds nothing: one that cannot be read or parsed holds values nobody could then mask.
const readJson = async (path: string): Promise<Entries> => {
    const text = await readFile(path, "utf8").catch(undefinedIfMissing);
    if (text === undefined) {
        return [];
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        // The parse error is not kept: its message quotes the text around the fault, which is secret values.
        throw new SecretStoreUnreadableError(`${path} is not valid JSON`);
    }
    const parsed = GeneratedSecretsSchema.safeParse(raw);
    if (!parsed.success) {
        throw new SecretStoreUnreadableError(`${path} is not a JSON object of values`);
    }
    return Object.entries(parsed.data);
};

const readEnv = async (path: string): Promise<Entries> => {
    const text = await readFile(path, "utf8").catch(undefinedIfMissing);
    return text === undefined ? [] : Object.entries(parseEnv(text)).flatMap(([key, value]) => (value === undefined ? [] : [[key, value] as const]));
};

// A vault names each value `<id>/<field>`, the vault layout the terminal filter reads the same file with.
const vaultEntries = (vaulted: SecretVaultContents): Entries =>
    Object.entries(vaulted).flatMap(([id, fields]) => Object.entries(fields).map(([field, value]) => [`${id}/${field}`, value] as const));

// What the keyrings on the owner's computers left here (secrets/device/): the `copy` entries kept as ordinary secrets,
// and the values released for one use each, which the registry lists only so they mask.
export interface KeptFromKeyrings {
    readonly copies: () => Promise<Readonly<Record<string, string>>>;
    readonly released: () => Readonly<Record<string, string>>;
}

const NOTHING_FROM_KEYRINGS: KeptFromKeyrings = { copies: async () => ({}), released: () => ({}) };

export const secretRegistryOf = (
    vault: SecretVault,
    desiredStateRepo: () => string,
    sandbox: Pick<SandboxSecrets, "all">,
    keyrings: KeptFromKeyrings = NOTHING_FROM_KEYRINGS,
) => {
    // One reader per store the list names. The auth-root stores are read through their own documents (schema, mode,
    // refusal of an unreadable file), the seams the daemon already holds; the desired-state files are read raw, as the
    // terminal filter reads every store. Exhaustive over `source`, so a store added to the list cannot go unread here.
    const entriesOf = async (store: SecretStore): Promise<Entries> => {
        switch (store.source) {
            case "env":
                return readEnv(join(desiredStateRepo(), store.path));
            case "sandbox":
                return Object.entries(await sandbox.all());
            case "generated":
                return readJson(join(desiredStateRepo(), store.path));
            case "capability":
                return vaultEntries(await vault.all());
            case "copy":
                return Object.entries(await keyrings.copies());
            case "device":
                return Object.entries(keyrings.released());
        }
    };
    return async (): Promise<readonly NamedSecret[]> => {
        const read = await Promise.all(SECRET_STORES.map(async (store) => ({ store, entries: await entriesOf(store) })));
        const byName = new Map<string, NamedSecret>();
        for (const { store, entries } of read) {
            for (const [name, value] of entries) {
                if (value !== "" && !byName.has(name)) {
                    byName.set(name, { name, value, source: store.source });
                }
            }
        }
        return [...byName.values()];
    };
};
