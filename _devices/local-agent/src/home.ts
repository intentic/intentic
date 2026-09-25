import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";

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

// Bun fixes os.homedir() at startup; only the environment follows a HOME set later, which is how a test redirects it.
export const homeDir = (): string => (process.platform === "win32" ? process.env["USERPROFILE"] : process.env["HOME"]) || homedir();

export const agentHome = (name: string): AgentHome => {
    const dir = join(homeDir(), ".intentic", name);
    return { dir, configPath: join(dir, "config.json") };
};

// 0700 on the directory and 0600 on the file, re-applied on every write since neither mode tightens what already exists.
export const writeSecretFile = async (path: string, dir: string, contents: string): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => undefined);
    await writeFileAtomic(path, contents, 0o600);
};
