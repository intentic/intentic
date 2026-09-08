import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Connection, type Credential, credentialOf } from "./accounts.js";
import { runtimeDir, workspaceRoot } from "./paths.js";
import { type AccessToken, mintToken } from "./token.js";

// One access token per connection, reused for its hour; cached in a file under the workspace's runtime tree since `gw`
// is a fresh process per command. Keyed by a fingerprint of the credential, not the connection name, so rotating the
// refresh token makes the old entry simply stop matching. The file holds only the one-hour bearer token, written 0600.

interface CachedToken extends AccessToken {
    readonly fingerprint: string;
}

// The durable secret, hashed, never the secret itself, since this file is the one artifact of the credential that
// outlives the process.
const fingerprintOf = (credential: Credential): string =>
    createHash("sha256")
        .update(
            credential.mode === "user" ? `${credential.clientId}:${credential.refreshToken}` : `${credential.clientEmail}:${credential.privateKey}`,
        )
        .digest("hex")
        .slice(0, 16);

// A token about to expire will 401 mid-request, so it's treated as absent a minute early.
const SKEW_SECONDS = 60;

const cachePath = (env: NodeJS.ProcessEnv, cwd: string, connection: Connection): string =>
    join(runtimeDir(workspaceRoot(env, cwd), connection.name), "token.json");

const readCache = async (path: string, fingerprint: string, now: number): Promise<string | undefined> => {
    let raw: string;
    try {
        raw = await readFile(path, "utf8");
    } catch {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<CachedToken>;
        if (parsed.fingerprint !== fingerprint || typeof parsed.token !== "string" || typeof parsed.expiresAt !== "number") {
            return undefined;
        }
        return parsed.expiresAt - SKEW_SECONDS > now ? parsed.token : undefined;
    } catch {
        // A truncated or hand-edited file reads as "no token"; it must never break a command.
        return undefined;
    }
};

export interface Session {
    readonly connection: Connection;
    // The bearer token for this hour, minted on first use and reused from the cache after.
    readonly token: () => Promise<string>;
    // Drops the cached token and mints a fresh one; what a 401 mid-command means.
    readonly refresh: () => Promise<string>;
}

export const openSession = (connection: Connection, env: NodeJS.ProcessEnv, cwd: string, clock: () => number): Session => {
    const credential = credentialOf(connection);
    const fingerprint = fingerprintOf(credential);
    const path = cachePath(env, cwd, connection);
    let pending: Promise<string> | undefined;

    const mint = async (): Promise<string> => {
        const now = Math.floor(clock() / 1000);
        const minted = await mintToken(connection, credential, now);
        const entry: CachedToken = { ...minted, fingerprint };
        // Best effort: a read-only or full disk must not stop a command that already has a good token in hand.
        await mkdir(join(path, ".."), { recursive: true }).catch(() => undefined);
        await writeFile(path, JSON.stringify(entry), { mode: 0o600 }).catch(() => undefined);
        return minted.token;
    };

    return {
        connection,
        token: async () => {
            if (pending === undefined) {
                pending = (async () => (await readCache(path, fingerprint, Math.floor(clock() / 1000))) ?? (await mint()))();
            }
            return pending;
        },
        refresh: async () => {
            pending = mint();
            return pending;
        },
    };
};
