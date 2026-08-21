/* WHICH OBSIDIAN VAULTS THIS SHELL IS CARRYING, read off the environment alone.
 *
 * The daemon injects a cli capability's env vars suffixed with the instance id (cli-env.ts: `obsidian` →
 * `OBSIDIAN_URL_OBSIDIAN`, `work-vault` → `OBSIDIAN_URL_WORK_VAULT`), which is what lets two vaults coexist in
 * one shell. So the set of connected vaults is not something to ask the daemon for, it is already here, and
 * `OBSIDIAN_URL_*` is the key that enumerates it. The google-workspace connector reads its accounts the same
 * way, for the same reason.
 *
 * A HALF-FILLED CARD IS A CONNECTION WITH A PROBLEM, not an absent one. Dropping it would make `obsidian`
 * answer "no vault is connected" to someone looking straight at their connected card, and the true answer,
 * "this one has no API key", is the only one they can act on. */

// The leaf module, not the barrel: the barrel is the whole wire contract, and importing it here put every oRPC
// route and the zod that types them into a CLI that needs one naming rule: 29 kB of `kb` next to 376 kB of
// this. Same reason ./tunnel-ids and ./session-names are their own entry points.
import { envSuffix } from "@intentic/sandbox-contract/capability-env";

export interface VaultConnection {
    // The instance name as `--vault` accepts it: the env suffix, lowercased. `envSuffix` of this is the suffix
    // again, so a name printed by `obsidian vaults` always selects the connection it was printed for.
    readonly name: string;
    // No trailing slash, so every path in rest.ts is built by plain concatenation.
    readonly url: string;
    readonly apiKey: string;
    // The card's write switch. Off means this CLI refuses every verb that changes the vault, the owner's own
    // notes are not something an agent gets to edit because it happened to be able to reach them.
    readonly write: boolean;
    // Vault folder new notes are written into. "" is the vault root.
    readonly folder: string;
    // undefined when the card can be used, `problem` says why not, in the owner's terms.
    readonly problem: string | undefined;
}

const URL_KEY = /^OBSIDIAN_URL_(.+)$/;

type Env = Record<string, string | undefined>;

const value = (env: Env, key: string, suffix: string): string => (env[`${key}_${suffix}`] ?? "").trim();

// Trailing slashes and a bare host are both things a person types into a URL field, and neither is worth an
// error: one is cosmetic, the other has exactly one sensible reading (the plugin serves https).
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
        // A leading or trailing slash here is the difference between "notes/x.md" and "/notes//x.md", and the
        // person filling the field has no way to know which this side wants.
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

/* The one this command is for. A single connection needs no naming, which is the whole case for most people,
 * and two do, because guessing between somebody's personal and work vaults is a wrong answer that looks right. */
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
