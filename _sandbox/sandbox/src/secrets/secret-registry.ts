import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { ENV_FILE, SECRETS_FILE } from "@intentic/scaffold";
import type { SecretVault } from "../capabilities/secret-vault.js";

/* EVERY CREDENTIAL VALUE THIS SANDBOX HOLDS, each under a stable NAME — the registry both halves of the
 * secret machinery read.
 *
 * The name is the whole point. Masking used to blank a stored value to an anonymous `***`, which destroyed
 * information twice over: the model could not tell WHICH credential it was looking at, and a file it read and
 * rewrote came back with the mask pasted over the real value — a silent credential loss. A stable
 * `{{secret:name}}` token closes both: the read path masks a value TO its reference, and the write path
 * resolves the same reference BACK to the value at the moments it actually leaves (a shell command, a browser
 * keystroke) — so the token round-trips losslessly through the model's context, and the value never enters it.
 *
 * Three stores, because the product has three kinds of stored secret and all three reach the agent's
 * environment: the DevOps `.env` (user-typed deploy values — named by their KEY), the deploy engine's
 * generated `.secrets.json` (engine-minted values — same key namespace), and the capability vault (a
 * connector's token, a browser account's password — named `<capability>/<field>`, because one capability may
 * hold several). Env wins a name collision, generated second — the user's own value is the one they mean —
 * though the namespaces are disjoint in practice (env keys are SCREAMING_SNAKE, capability ids are not).
 *
 * Read on each call rather than cached: a credential connected mid-turn must be masked in the very next tool
 * result, and these are three small files against a model round-trip. */

export interface NamedSecret {
    // The reference name: an env key (`CLOUDFLARE_API_TOKEN`) or `<capability>/<field>` (`reddit/password`).
    readonly name: string;
    readonly value: string;
    readonly source: "env" | "generated" | "capability";
}

// The reference token as the model reads and writes it. Double braces rather than a value-lookalike on
// purpose: substitution must be exact-match, and a token shaped like a real key invites both missed
// resolutions (a model "fixing" it) and reasoning errors ("this key is 24 characters" — it is not).
export const secretReference = (name: string): string => `{{secret:${name}}}`;

// The name alphabet is what the three stores can produce: env keys, capability ids, config field names, and
// the one `/` that joins the latter two. Anything else inside the braces is left alone — a template file
// using `{{secret:...}}` for its own purposes with characters outside this set is not this machinery's.
const REFERENCE = /\{\{secret:([A-Za-z0-9_./-]+)\}\}/g;

export interface ResolvedReferences {
    readonly text: string;
    // Names resolved, in order of first appearance — what the audit trail records.
    readonly used: readonly string[];
    // Names that matched the token shape but no stored secret — the caller fails hard on these, because a
    // reference passed through as literal text is a config holding the string "{{secret:...}}" where a
    // credential should be, discovered only when the deploy 401s.
    readonly unknown: readonly string[];
}

// Replace every known `{{secret:name}}` with its value. Textual on purpose — the reference stands wherever
// the value would (inside a quoted JSON body, an env assignment, a URL), which no env-var indirection
// survives quoting-intact.
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

// Whether a text carries any reference-shaped token at all — the cheap pre-check callers use to skip the
// registry read on the overwhelmingly common command that names no secret.
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
    // parseEnv answers a Dict — every key it enumerates has a string value, which is all this reads.
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
