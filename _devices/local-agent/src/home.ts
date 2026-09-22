import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// Local agent state lives under `~/.intentic/<name>`. This module exists mainly to enforce permissions: those files
// hold durable sandbox credentials, and the default umask would leave them world-readable on a shared machine.

// Where a command writes user-facing progress: stdout if interactive, an append-only log file if detached.
export type Log = (message: string) => void;

export interface AgentHome {
    // `~/.intentic/<name>`; agent-specific files (keypair, audit log, pidfile) join onto this.
    readonly dir: string;
    // `<dir>/config.json`: what setup writes and every other command reads back.
    readonly configPath: string;
}

export const agentHome = (name: string): AgentHome => {
    const dir = join(homedir(), ".intentic", name);
    return { dir, configPath: join(dir, "config.json") };
};

// Windows refuses a rename over a file another process holds open for a moment; these are that moment, not a fault.
const TRANSIENT_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 10;
const RENAME_RETRY_MS = 25;

const renameOver = async (from: string, to: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
        try {
            await rename(from, to);
            return;
        } catch (error) {
            if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME.has((error as NodeJS.ErrnoException).code ?? "")) {
                throw error;
            }
            // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded retry of one rename, serial by definition
            await sleep(RENAME_RETRY_MS);
        }
    }
};

// Per write, not per process: two writes of one path in flight at once must not share a staging file.
let staging = 0;

// A reader sees the previous file or the new one whole, never a torn write: the bytes land beside it, then replace it.
export const writeFileAtomic = async (path: string, contents: string, mode = 0o644): Promise<void> => {
    staging += 1;
    const staged = `${path}.${process.pid}-${staging}.tmp`;
    try {
        await writeFile(staged, contents, { encoding: "utf8", mode });
        await renameOver(staged, path);
    } catch (error) {
        await rm(staged, { force: true }).catch(() => undefined);
        throw error;
    }
};

// 0700 on the directory and 0600 on the file, re-applied on every write since neither mode tightens what already exists.
export const writeSecretFile = async (path: string, dir: string, contents: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    await writeFileAtomic(path, contents, 0o600);
};
