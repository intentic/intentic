import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Connection, type Credential, credentialOf } from "./accounts.js";
import { runtimeDir, workspaceRoot } from "./paths.js";
import { type AccessToken, mintToken } from "./token.js";

/* ONE ACCESS TOKEN PER CONNECTION, REUSED FOR ITS HOUR.
 *
 * `gw` is a fresh process per command and an agent runs a lot of them, so without this every `gw mail search`
 * pays a token round trip before it asks Google anything. The cache is a small file under the workspace's
 * runtime tree, the same place the watcher keeps its resume marks.
 *
 * IT IS KEYED BY A FINGERPRINT OF THE CREDENTIAL, not by the connection name. Rotate the refresh token on the
 * card and the old entry simply stops matching, which is the behaviour that needs no invalidation step: a
 * cache that answered for a credential the owner has replaced is a cache that hides the rotation. The file
 * holds a one-hour bearer token and is written 0600; the durable secret it came from is already in this
 * process's environment, so nothing new is exposed by it existing. */

interface CachedToken extends AccessToken {
    readonly fingerprint: string;
}

// The durable secret, hashed. Never the secret itself: this file is the one artifact of the credential that
// outlives the process.
const fingerprintOf = (credential: Credential): string =>
    createHash("sha256")
        .update(
            credential.mode === "user" ? `${credential.clientId}:${credential.refreshToken}` : `${credential.clientEmail}:${credential.privateKey}`,
        )
        .digest("hex")
        .slice(0, 16);

// A token about to expire is a token that will 401 mid-request, so it is treated as absent a minute early.
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
        // A truncated or hand-edited file reads as "no token", it must never be able to break a command.
        return undefined;
    }
};

export interface Session {
    readonly connection: Connection;
    // The bearer token for this hour, minted on first use and reused from the cache after that.
    readonly token: () => Promise<string>;
    // Drop the cached token and mint a fresh one, what a 401 mid-command means.
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
        // Best effort: a read-only or full disk must not stop a command that has a perfectly good token in hand.
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
