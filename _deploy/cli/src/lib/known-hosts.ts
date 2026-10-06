import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createSshExecutor, type HostKeyStore, type SshExecutor } from "@intentic/providers";
import { KNOWN_HOSTS_FILE } from "./artifact.js";

// A file-backed HostKeyStore: the host-key lockfile beside the artifact, mapping "address:port" → base64
// public key. Same on-disk conventions as .secrets.json (mode 0o600, 4-space JSON, trailing newline). `set`
// is read-modify-write, safe because apply reconciles strictly sequentially, so no two writes race.
const hostKeyId = (host: string, port: number): string => `${host}:${port}`;

export const createKnownHostsStore = (dir: string): HostKeyStore => {
    const path = join(dir, KNOWN_HOSTS_FILE);
    const read = async (): Promise<Record<string, string>> =>
        existsSync(path) ? (JSON.parse(await readFile(path, "utf8")) as Record<string, string>) : {};
    return {
        get: async (host, port) => (await read())[hostKeyId(host, port)],
        set: async (host, port, key) => {
            const store = await read();
            store[hostKeyId(host, port)] = key;
            await writeFile(path, `${JSON.stringify(store, undefined, 4)}\n`, { mode: 0o600 });
        },
    };
};

// The executor every command that reaches a host uses: host keys pinned in the lockfile beside the artifact, so a
// changed key is refused instead of trusted. One constructor so no command can fall back to trust-on-first-use.
export const pinnedSshExecutor = (dir: string): SshExecutor => createSshExecutor(createKnownHostsStore(dir));
