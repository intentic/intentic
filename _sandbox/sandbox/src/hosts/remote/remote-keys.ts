import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

/* The two secrets a connected computer's remoted runs with, one pair per device (2026-11-20): the uplink token it dials
   netd with, whose SHA-256 is all netd is told, and the media key it checks viewers' tokens with, castd's format. Kept
   in a file per device under the container's run directory, beside netd's sockets, as castd's key is: a daemon that
   restarts reads the same pair, so the uplink netd kept across the restart and the tokens already handed out stay good;
   a new container starts with none, as netd does. Owner-only, never logged, never sent anywhere but to the device. */

const REMOTE_KEYS_DIR = "/run/intentic/remote";

const KEY_BYTES = 32;

const NAME = /^[A-Za-z0-9_-]{1,64}$/u;

const KeysSchema = z.object({ uplinkToken: z.string().min(1), mediaKey: z.string().min(1) });

export interface RemoteKeys {
    // What remoted dials netd with, base64url.
    readonly uplinkToken: string;
    // What remoted checks tokens with, base64url; tokens are signed with its decoded bytes.
    readonly mediaKey: string;
}

// The lowercase hex SHA-256 of the uplink token, which is what netd is registered with.
export const digestOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

// The name a device's uplink goes by on netd's routes and socket: its connection key where that is already one
// (`[A-Za-z0-9_-]{1,64}`, every card id), else the key made safe with a digest of it after, so a WSL distro's connection
// (`rog::wsl:archlinux`) never meets a card that happens to be spelled like its safe form.
export const uplinkIdOf = (key: string): string => {
    if (NAME.test(key)) {
        return key;
    }
    const safe = key.replaceAll(/[^A-Za-z0-9_-]+/gu, "-").slice(0, 55);
    return `${safe}-${digestOf(key).slice(0, 8)}`;
};

export interface RemoteKeyStore {
    // The device's pair, made on first ask and read back after a restart.
    readonly of: (uplinkId: string) => RemoteKeys;
    // Whether a pair is held for it, without making one.
    readonly has: (uplinkId: string) => boolean;
    readonly forget: (uplinkId: string) => void;
    readonly held: () => readonly string[];
}

const fresh = (): RemoteKeys => ({ uplinkToken: randomBytes(KEY_BYTES).toString("base64url"), mediaKey: randomBytes(KEY_BYTES).toString("base64url") });

export const fileRemoteKeys = (dir: string = REMOTE_KEYS_DIR): RemoteKeyStore => {
    const pathOf = (uplinkId: string): string => join(dir, `${uplinkId}.json`);
    const cache = new Map<string, RemoteKeys>();
    const read = (uplinkId: string): RemoteKeys | undefined => {
        const path = pathOf(uplinkId);
        return existsSync(path) ? parseJsonWith(readFileSync(path, "utf8"), KeysSchema) : undefined;
    };
    return {
        of: (uplinkId) => {
            const known = cache.get(uplinkId) ?? read(uplinkId);
            if (known !== undefined) {
                cache.set(uplinkId, known);
                return known;
            }
            const made = fresh();
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            writeFileSync(pathOf(uplinkId), JSON.stringify(made), { mode: 0o600 });
            chmodSync(pathOf(uplinkId), 0o600);
            cache.set(uplinkId, made);
            return made;
        },
        has: (uplinkId) => cache.has(uplinkId) || read(uplinkId) !== undefined,
        forget: (uplinkId) => {
            cache.delete(uplinkId);
            rmSync(pathOf(uplinkId), { force: true });
        },
        held: () => (existsSync(dir) ? readdirSync(dir).flatMap((name) => (name.endsWith(".json") ? [name.slice(0, -".json".length)] : [])) : []),
    };
};
