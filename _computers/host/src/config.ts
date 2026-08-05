import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { agentHome, writeSecretFile } from "@intentic/local-agent";
import type { HostScopes } from "@intentic/sandbox-contract";

// Everything this agent persists lives under ~/.intentic/host: the sandbox it is enrolled with, its enrollment
// token, the last scopes the sandbox pushed, and the audit log of everything the agent did here. The directory
// and the 0600 floor on what lands in it belong to @intentic/local-agent — every agent on a user's machine
// keeps a credential in the same shape, and the one that kept its own copy of this wrote it world-readable.
const home = agentHome("host");
export const baseDir = home.dir;
export const configPath = home.configPath;
export const auditPath = join(baseDir, "audit.jsonl");
export const runLogPath = join(baseDir, "host.log");
export const runPidPath = join(baseDir, "host.pid");

/* What `intentic-host setup` writes and every other command reads back.
 *
 * The scopes are a CACHE, not the source of truth. The sandbox pushes them on every connect, so what is written
 * here only decides how the agent behaves in the seconds before the first push (and if it is ever started while
 * offline). They are stored at all so that a refusal reads the same before and after a reconnect — an agent that
 * allowed everything until the first scopes frame would have a window where the grant was whatever the last
 * install defaulted to.
 *
 * The token is the one real credential. It sits in a 0600 file rather than the OS keychain today; the keychain
 * is the right home for it and is worth doing before this ships widely (Windows DPAPI / libsecret), because a
 * file readable by every process running as this user is a weaker boundary than the grant it protects. */
export interface HostConfigFile {
    readonly sandboxUrl: string;
    // The capability id on the sandbox — this computer's name, and the prefix of its tools over there.
    readonly id: string;
    readonly token: string;
    readonly scopes: HostScopes;
}

export const readHostConfig = async (): Promise<HostConfigFile> => JSON.parse(await readFile(configPath, "utf8")) as HostConfigFile;

export const writeHostConfig = async (config: HostConfigFile): Promise<void> =>
    await writeSecretFile(configPath, baseDir, JSON.stringify(config, undefined, 2));

// Persist the scopes the sandbox just pushed, leaving the rest of the config alone. Best-effort by design: the
// live grant is already in memory and enforcing, so failing to write the cache must never drop the connection.
export const rememberScopes = async (scopes: HostScopes): Promise<void> => {
    const config = await readHostConfig().catch(() => undefined);
    if (config === undefined) {
        return;
    }
    await writeHostConfig({ ...config, scopes }).catch(() => undefined);
};
