import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isMissing } from "@intentic/base/errors";
import { join } from "node:path";
import { BROWSER_MEDIA_SOCKET_DIR } from "@intentic/sandbox-contract/browser-wire";

/* What opens a window's media socket: a token the daemon mints and castd checks (castd's src/token.rs is the other
   half, with the test vector both are held to). `base64url(payload) + "." + base64url(HMAC-SHA256(key, payload))`, no
   padding, the payload the JSON `{"s":<session>,"exp":<ms>,"ro":<bool>,"iat":<ms>}` in that key order. castd checks it
   at the upgrade, and again when the viewer sends a fresher one on its open socket (browser-wire's `token`): a socket
   outlives its token by castd's grace at most, so the token is short-lived and the browser view socket hands out a
   fresh one before it lapses (media-view.ts). `iat` is when it was minted: castd refuses one minted before the daemon
   last dropped the window's viewers (castd.ts dropCastdViewers), so a token held by someone whose access went is dead.

   The key is one per container boot, random, in the cast directory beside the sockets: every castd is started with
   `--key-file` naming it, and a daemon that restarts reads the same file, so the castds it adopts still accept what it
   mints. Never logged, never sent anywhere. */

// The directory castd's sockets, the key and their bookkeeping live in: browser-wire's, where netd looks.
export const CAST_DIR = BROWSER_MEDIA_SOCKET_DIR;

const KEY_FILE = "key";

const KEY_BYTES = 32;

export interface MediaClaims {
    // castd's `--session`, the name in the media path.
    readonly session: string;
    // When the token stops opening sockets, in ms since the epoch.
    readonly expiresAt: number;
    // A viewer who may watch and not drive: castd ignores its input.
    readonly readOnly: boolean;
    // When it is minted, in ms since the epoch; left out of the payload when not given (castd's test vector has none).
    readonly issuedAt?: number | undefined;
}

// Mints a token over the claims, the payload written byte for byte as castd's own `sign` writes it.
export const mintMediaToken = (key: Uint8Array, claims: MediaClaims): string => {
    const fields = { s: claims.session, exp: Math.floor(claims.expiresAt), ro: claims.readOnly };
    const payload = Buffer.from(JSON.stringify(claims.issuedAt === undefined ? fields : { ...fields, iat: Math.floor(claims.issuedAt) }), "utf8");
    const mac = createHmac("sha256", key).update(payload).digest();
    return `${payload.toString("base64url")}.${mac.toString("base64url")}`;
};

// The key and the file castd is started with (`--key-file`).
export interface MediaKey {
    readonly key: Buffer;
    readonly path: string;
}

// The key castd checks tokens with, made on first use: an existing file is this boot's (an earlier daemon life's,
// whose castds are still running) and is read, never replaced. The directory is the owner's alone, like netd's run
// directory it sits in.
export const ensureMediaKey = (dir: string = CAST_DIR): MediaKey => {
    const path = join(dir, KEY_FILE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // No file yet is the first castd of this boot. Read, not asked about first, so nothing comes between the two.
    let existing: Buffer | undefined;
    try {
        existing = readFileSync(path);
    } catch (error) {
        if (!isMissing(error)) {
            throw error;
        }
    }
    if (existing !== undefined && existing.length >= KEY_BYTES) {
        return { key: existing, path };
    }
    const key = randomBytes(KEY_BYTES);
    // `wx` would refuse a short file left by a crash mid-write; that file is no key anyone holds, so it is replaced.
    writeFileSync(path, key, { mode: 0o600 });
    chmodSync(path, 0o600);
    return { key, path };
};
