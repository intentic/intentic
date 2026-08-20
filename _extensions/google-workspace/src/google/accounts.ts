/* WHICH GOOGLE ACCOUNTS THIS SHELL IS CARRYING, read off the environment alone.
 *
 * The daemon injects a cli capability's env vars suffixed with the instance id (cli-env.ts: `google` →
 * `GOOGLE_MODE_GOOGLE`, `work-gmail` → `GOOGLE_MODE_WORK_GMAIL`), which is what lets two Google accounts
 * coexist in one shell. So the set of connected accounts is not something to ask the daemon for, it is
 * already here, and `GOOGLE_MODE_*` is the key that enumerates it.
 *
 * A HALF-FILLED CARD IS A CONNECTION WITH A PROBLEM, not an absent one. Dropping it would make `gw` answer
 * "no Google account is connected" to someone looking straight at their connected card, and the true answer,
 * "this one has no refresh token", is the only one they can act on. */

import { envSuffix } from "@intentic/sandbox-contract";

export type AccessLevel = "read" | "write";

// The two ways a card authenticates. `user` is one person's OAuth grant; `domain` is a Workspace service
// account impersonating one person, which is why it still carries the address rather than being account-less.
export type Credential =
    | { readonly mode: "user"; readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string }
    | { readonly mode: "domain"; readonly clientEmail: string; readonly privateKey: string; readonly tokenUri: string };

export interface Connection {
    // The instance name as `--account` accepts it: the env suffix, lowercased. `envSuffix` of this is the
    // suffix again, so a name printed by `gw accounts` always selects the connection it was printed for.
    readonly name: string;
    readonly email: string;
    readonly access: AccessLevel;
    readonly mode: "user" | "domain";
    // undefined when the card cannot authenticate, `problem` says why, in the owner's terms.
    readonly credential: Credential | undefined;
    readonly problem: string | undefined;
}

const MODE_KEY = /^GOOGLE_MODE_(.+)$/;
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

type Env = Record<string, string | undefined>;

/* THE CARD'S SEVEN VALUES, whichever side they were read from. `gw` finds them in its environment (the daemon
 * suffixes each with the instance id); the watcher is handed them as a stored capability config over the
 * listener state route. Same card, same rules, so the rules are written against this rather than twice. */
export interface CardFields {
    readonly mode: string;
    readonly email: string;
    readonly access: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
    readonly serviceAccountKey: string;
}

const value = (env: Env, key: string, suffix: string): string => (env[`${key}_${suffix}`] ?? "").trim();

// The pasted service-account JSON, as far as minting a token needs it. Anything else in the file (project id,
// key id, the console URLs) is Google's bookkeeping and never reaches a request.
const domainCredential = (raw: string): { credential?: Credential; problem?: string } => {
    if (raw === "") {
        return { problem: "no service account key on the card" };
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return { problem: "the service account key is not valid JSON — paste the whole downloaded file" };
    }
    const clientEmail = parsed["client_email"];
    const privateKey = parsed["private_key"];
    if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
        return { problem: "the service account key has no client_email/private_key — that is not a service account JSON key" };
    }
    const tokenUri = parsed["token_uri"];
    return { credential: { mode: "domain", clientEmail, privateKey, tokenUri: typeof tokenUri === "string" ? tokenUri : DEFAULT_TOKEN_URI } };
};

const userCredential = (fields: CardFields): { credential?: Credential; problem?: string } => {
    const missing = [
        ...(fields.clientId === "" ? ["client ID"] : []),
        ...(fields.clientSecret === "" ? ["client secret"] : []),
        ...(fields.refreshToken === "" ? ["refresh token"] : []),
    ];
    if (missing.length > 0) {
        return { problem: `the card is missing its ${missing.join(", ")}` };
    }
    return { credential: { mode: "user", clientId: fields.clientId, clientSecret: fields.clientSecret, refreshToken: fields.refreshToken } };
};

export const connectionOf = (name: string, fields: CardFields): Connection => {
    const domain = fields.mode === "domain";
    const resolved = domain ? domainCredential(fields.serviceAccountKey) : userCredential(fields);
    return {
        name,
        email: fields.email,
        // `read` only when it was chosen; anything else reads as write, which is the card's own default, a
        // silent downgrade to read-only would look like a broken tool rather than a setting.
        access: fields.access === "read" ? "read" : "write",
        mode: domain ? "domain" : "user",
        credential: resolved.credential,
        problem: resolved.problem ?? (fields.email === "" ? "the card has no account address" : undefined),
    };
};

// The stored capability config, as the watcher receives it over the listener state route, the same seven
// values the daemon spread across the environment for `gw`, still in one object.
export interface CardConfig {
    readonly mode?: string;
    readonly email?: string;
    readonly access?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly refreshToken?: string;
    readonly serviceAccountKey?: string;
}

export const fieldsOfConfig = (config: CardConfig): CardFields => ({
    mode: (config.mode ?? "").trim(),
    email: (config.email ?? "").trim(),
    access: (config.access ?? "").trim(),
    clientId: (config.clientId ?? "").trim(),
    clientSecret: (config.clientSecret ?? "").trim(),
    refreshToken: (config.refreshToken ?? "").trim(),
    serviceAccountKey: (config.serviceAccountKey ?? "").trim(),
});

export const connectionsFrom = (env: Env): Connection[] => {
    const connections: Connection[] = [];
    for (const [key, mode] of Object.entries(env)) {
        const suffix = MODE_KEY.exec(key)?.[1];
        if (suffix === undefined) {
            continue;
        }
        connections.push(
            connectionOf(suffix.toLowerCase(), {
                mode: (mode ?? "").trim(),
                email: value(env, "GOOGLE_EMAIL", suffix),
                access: value(env, "GOOGLE_ACCESS", suffix),
                clientId: value(env, "GOOGLE_CLIENT_ID", suffix),
                clientSecret: value(env, "GOOGLE_CLIENT_SECRET", suffix),
                refreshToken: value(env, "GOOGLE_REFRESH_TOKEN", suffix),
                serviceAccountKey: value(env, "GOOGLE_SERVICE_ACCOUNT_KEY", suffix),
            }),
        );
    }
    return connections.toSorted((a, b) => a.name.localeCompare(b.name));
};

const NONE_CONNECTED =
    "No Google account is connected. Add the Google Workspace card under Capabilities — it covers Gmail, Calendar, Drive, Docs, Sheets and Contacts.";

/* Which connection a command runs against. The single-account case is the one that has to need no flag, and
 * the several-account case is the one that must never guess: picking the first would send mail from whichever
 * card happened to sort first, which is the kind of wrong nobody notices until it is in someone's inbox. */
export const selectConnection = (connections: readonly Connection[], wanted: string | undefined): Connection => {
    if (connections.length === 0) {
        throw new Error(NONE_CONNECTED);
    }
    if (wanted !== undefined) {
        const suffix = envSuffix(wanted);
        const found = connections.find(
            (connection) => envSuffix(connection.name) === suffix || connection.email.toLowerCase() === wanted.toLowerCase(),
        );
        if (found === undefined) {
            throw new Error(`No connected Google account called "${wanted}". Connected: ${connections.map(describe).join(", ")}.`);
        }
        return found;
    }
    if (connections.length > 1) {
        throw new Error(`Several Google accounts are connected — pass --account: ${connections.map(describe).join(", ")}.`);
    }
    return connections[0] as Connection;
};

export const describe = (connection: Connection): string => (connection.email === "" ? connection.name : `${connection.name} (${connection.email})`);

// The credential, or the card's problem said out loud. Every command goes through here, so a card that cannot
// authenticate fails with what to fix rather than with whatever Google says about an empty token.
export const credentialOf = (connection: Connection): Credential => {
    if (connection.credential === undefined) {
        throw new Error(`The Google account "${describe(connection)}" is not usable: ${connection.problem ?? "its card is incomplete"}.`);
    }
    return connection.credential;
};
