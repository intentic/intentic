// Which Google accounts this shell carries, read off the environment: the daemon suffixes each cli capability's env
// vars with the instance id (`GOOGLE_MODE_GOOGLE`, `GOOGLE_MODE_WORK_GMAIL`...). A half-filled card is a connection
// with a problem, not an absent one: the true answer ("no refresh token") is what the owner can act on.

import { envSuffix } from "@intentic/sandbox-contract/policy/capability-env";

export type AccessLevel = "read" | "write";

// The three ways a card authenticates: `platform` is one person's grant to the platform's own client (the card's
// Connect Google button), refreshed through the daemon since the client secret stays on the platform; `user` is one
// person's grant to a client the owner brought; `domain` is a service account impersonating one person, hence the
// address. `cardId` is how the daemon finds the card whose refresh token it trades.
export type Credential =
    | { readonly mode: "platform"; readonly cardId: string; readonly refreshToken: string }
    | { readonly mode: "user"; readonly clientId: string; readonly clientSecret: string; readonly refreshToken: string }
    | { readonly mode: "domain"; readonly clientEmail: string; readonly privateKey: string; readonly tokenUri: string };

export interface Connection {
    // The instance name as `--account` accepts it: the env suffix, lowercased.
    readonly name: string;
    readonly email: string;
    readonly access: AccessLevel;
    readonly mode: "user" | "domain";
    // Undefined when the card can't authenticate; `problem` says why, in the owner's terms.
    readonly credential: Credential | undefined;
    readonly problem: string | undefined;
}

const MODE_KEY = /^GOOGLE_MODE_(.+)$/;
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";

type Env = Record<string, string | undefined>;

// The card's seven values, from whichever side they were read: `gw`'s environment, or the watcher's stored capability
// config. Same card, same rules, written once against this shape.
export interface RequestFields {
    readonly mode: string;
    readonly email: string;
    readonly access: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
    readonly serviceAccountKey: string;
}

const value = (env: Env, key: string, suffix: string): string => (env[`${key}_${suffix}`] ?? "").trim();

// The pasted service-account JSON, as far as minting a token needs it; everything else in the file (project id, key id,
// console URLs) never reaches a request.
const domainCredential = (raw: string): { credential?: Credential; problem?: string } => {
    if (raw === "") {
        return { problem: "no service account key on the card" };
    }
    let parsed: Record<string, unknown>;
    try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        return { problem: "the service account key is not valid JSON, paste the whole downloaded file" };
    }
    const clientEmail = parsed["client_email"];
    const privateKey = parsed["private_key"];
    if (typeof clientEmail !== "string" || typeof privateKey !== "string") {
        return { problem: "the service account key has no client_email/private_key, that is not a service account JSON key" };
    }
    const tokenUri = parsed["token_uri"];
    return { credential: { mode: "domain", clientEmail, privateKey, tokenUri: typeof tokenUri === "string" ? tokenUri : DEFAULT_TOKEN_URI } };
};

const userCredential = (name: string, fields: RequestFields): { credential?: Credential; problem?: string } => {
    // No client of the owner's own: the card was signed in with its Connect Google button, on the platform's client.
    if (fields.clientId === "" && fields.clientSecret === "") {
        return fields.refreshToken === ""
            ? { problem: "the card is not signed in yet: press Connect Google on its card under Capabilities" }
            : { credential: { mode: "platform", cardId: name, refreshToken: fields.refreshToken } };
    }
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

export const connectionOf = (name: string, fields: RequestFields): Connection => {
    const domain = fields.mode === "domain";
    const resolved = domain ? domainCredential(fields.serviceAccountKey) : userCredential(name, fields);
    return {
        name,
        email: fields.email,
        // `read` only when chosen; anything else is write, the card's own default.
        access: fields.access === "read" ? "read" : "write",
        mode: domain ? "domain" : "user",
        credential: resolved.credential,
        problem: resolved.problem ?? (fields.email === "" ? "the card has no account address" : undefined),
    };
};

// The stored capability config, as the watcher receives it over the listener state route, the same seven values as
// `RequestFields`, in one object.
export interface CardConfig {
    readonly mode?: string;
    readonly email?: string;
    readonly access?: string;
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly refreshToken?: string;
    readonly serviceAccountKey?: string;
}

export const fieldsOfConfig = (config: CardConfig): RequestFields => ({
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
    "No Google account is connected. Add the Google Workspace card under Capabilities: it covers Gmail, Calendar, Drive, Docs, Sheets and Contacts.";

// Which connection a command runs against. The single-account case must need no flag; the several-account case must
// never guess, since picking the first would silently send mail from the wrong card.
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
        throw new Error(`Several Google accounts are connected, pass --account: ${connections.map(describe).join(", ")}.`);
    }
    return connections[0] as Connection;
};

export const describe = (connection: Connection): string => (connection.email === "" ? connection.name : `${connection.name} (${connection.email})`);

// `--as` retargets a company connection at another person in the domain; a personal grant has nobody else it could act
// as. Only an address is a person: `gw drive get … --as md` names an export format, which must reach drive rather than
// be refused as an impersonation (or, on a company connection, attempted as one, as a user called "md").
export const retargetAs = (connection: Connection, as: string | undefined): Connection => {
    if (as === undefined || !as.includes("@")) {
        return connection;
    }
    if (connection.mode !== "domain") {
        throw new Error(
            `--as only works on a company (service account) connection. "${describe(connection)}" is one person's own grant, so it can only act as ${connection.email}.`,
        );
    }
    return { ...connection, email: as };
};

// The credential, or the card's problem said out loud; every command goes through here, so a bad card fails with what
// to fix.
export const credentialOf = (connection: Connection): Credential => {
    if (connection.credential === undefined) {
        throw new Error(`The Google account "${describe(connection)}" is not usable: ${connection.problem ?? "its card is incomplete"}.`);
    }
    return connection.credential;
};
