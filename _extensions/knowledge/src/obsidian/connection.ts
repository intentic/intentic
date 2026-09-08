// Connected Obsidian vaults, read from `OBSIDIAN_URL_<SUFFIX>` and sibling env vars, one suffix per instance. A vault
// missing a URL or key is still connected, with `problem` set, not absent.

import { envSuffix } from "@intentic/sandbox-contract/capability-env";

export interface VaultConnection {
    // Instance name as `--vault` accepts it: the env suffix, lowercased; round-trips through `envSuffix`.
    readonly name: string;
    // No trailing slash: paths in rest.ts are built by plain concatenation.
    readonly url: string;
    readonly apiKey: string;
    // Write switch; off refuses every verb that changes the vault.
    readonly write: boolean;
    // Empty string means the vault root.
    readonly folder: string;
    // Undefined when the card is usable; set to why not, in the owner's terms.
    readonly problem: string | undefined;
}

const URL_KEY = /^OBSIDIAN_URL_(.+)$/;

type Env = Record<string, string | undefined>;

const value = (env: Env, key: string, suffix: string): string => (env[`${key}_${suffix}`] ?? "").trim();

// A bare host normalises to https, never http.
export const normaliseUrl = (raw: string): string => {
    const trimmed = raw.trim().replace(/\/+$/, "");
    if (trimmed === "") {
        return "";
    }
    return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
};

const connectionOf = (name: string, fields: { url: string; apiKey: string; write: string; folder: string }): VaultConnection => {
    const url = normaliseUrl(fields.url);
    const problem =
        url === ""
            ? "no Local REST API URL on the card"
            : fields.apiKey === ""
              ? "no API key on the card: copy it from Obsidian ▸ Settings ▸ Local REST API"
              : undefined;
    return {
        name,
        url,
        apiKey: fields.apiKey,
        write: fields.write.toLowerCase() === "on",
        // No leading or trailing slash: paths built by concatenation do not double up.
        folder: fields.folder.replace(/^\/+|\/+$/g, ""),
        problem,
    };
};

export const vaultConnections = (env: Env): readonly VaultConnection[] => {
    const found: VaultConnection[] = [];
    for (const key of Object.keys(env)) {
        const suffix = URL_KEY.exec(key)?.[1];
        if (suffix === undefined) {
            continue;
        }
        found.push(
            connectionOf(suffix.toLowerCase(), {
                url: value(env, "OBSIDIAN_URL", suffix),
                apiKey: value(env, "OBSIDIAN_API_KEY", suffix),
                write: value(env, "OBSIDIAN_WRITE", suffix),
                folder: value(env, "OBSIDIAN_FOLDER", suffix),
            }),
        );
    }
    return found.toSorted((a, b) => a.name.localeCompare(b.name));
};

// Selects the vault a command targets; a single connection is unambiguous, more than one requires --vault.
export const selectVault = (
    connections: readonly VaultConnection[],
    wanted: string | undefined,
): { readonly vault: VaultConnection } | { readonly error: string } => {
    if (connections.length === 0) {
        return { error: `no Obsidian vault is connected, add the Obsidian card in Capabilities.` };
    }
    if (wanted === undefined) {
        const [only] = connections;
        return connections.length === 1 && only !== undefined
            ? { vault: only }
            : { error: `which vault? --vault ${connections.map((connection) => connection.name).join(" | ")}` };
    }
    const suffix = envSuffix(wanted);
    const match = connections.find((connection) => envSuffix(connection.name) === suffix);
    return match === undefined
        ? { error: `no connected vault named "${wanted}", have: ${connections.map((connection) => connection.name).join(", ")}` }
        : { vault: match };
};
