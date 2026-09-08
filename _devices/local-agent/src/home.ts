import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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

// 0700 on the directory and 0600 on the file: a file-only mode still leaves names readable via the listing. Applied on
// every write, since mkdir won't tighten a directory that already exists.
export const writeSecretFile = async (path: string, dir: string, contents: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
};
