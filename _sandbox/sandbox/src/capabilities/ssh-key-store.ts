import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";

// The private half of every SSH key the sandbox holds: a connected machine's key and the key it registered on a git
// account. Kept in the auth root beside the vault, root-only, and nowhere else: the agent's ssh config names only the
// public half, and the sandbox's own ssh agent (broker/ssh-agent.ts) signs with the private one on the agent's behalf,
// so nothing the agent runs is ever handed a key it could copy out.

export const SSH_KEYS_DIR = "ssh-keys";

// What an alias may be: a capability id or a git host's name. Never a path: no separator, no leading dot, so a file
// in the store can only ever be one alias's key.
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/u;

export const isKeyAlias = (alias: string): boolean => ALIAS.test(alias);

const checked = (alias: string): string => {
    if (!isKeyAlias(alias)) {
        throw new Error(`ssh key store: "${alias}" is not a key alias`);
    }
    return alias;
};

export interface SshKeyStore {
    // Where the store lives; daemon-side only (an `ssh -i` the daemon itself runs), never handed to a turn.
    readonly dir: string;
    readonly pathOf: (alias: string) => string;
    // Replaces an alias's key. Written atomically, 0600, under a 0700 directory.
    readonly put: (alias: string, privateKey: string) => Promise<void>;
    readonly get: (alias: string) => Promise<string | undefined>;
    readonly has: (alias: string) => Promise<boolean>;
    // A missing key is fine.
    readonly remove: (alias: string) => Promise<void>;
    // Every alias holding a key, in name order; empty when the store was never written.
    readonly aliases: () => Promise<readonly string[]>;
}

export const fileSshKeyStore = (dir: string): SshKeyStore => {
    const pathOf = (alias: string): string => join(dir, checked(alias));
    const get = async (alias: string): Promise<string | undefined> => readFile(pathOf(alias), "utf8").catch(undefinedIfMissing);
    return {
        dir,
        pathOf,
        put: async (alias, privateKey) => {
            await mkdir(dir, { recursive: true, mode: 0o700 });
            await writeFileAtomic(pathOf(alias), privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`, 0o600);
        },
        get,
        has: async (alias) => (await get(alias)) !== undefined,
        remove: async (alias) => {
            await rm(pathOf(alias), { force: true });
        },
        aliases: async () => {
            const names = (await readdir(dir).catch(undefinedIfMissing)) ?? [];
            // An interrupted atomic write's staging file starts with a dot, which no alias does.
            return names.filter(isKeyAlias).toSorted();
        },
    };
};
