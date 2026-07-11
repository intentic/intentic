import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Everything the agent persists lives under ~/.intentic/sync — the config it was set up with, the SSH keypair
// Mutagen authenticates with, and the ssh config/known_hosts Mutagen's ssh reads. No credentials: the agent
// enrolls its key once with a browser-minted pairing token, then all auth is the SSH key (Mutagen).
export const baseDir = join(homedir(), ".intentic", "sync");
export const configPath = join(baseDir, "config.json");
export const sshKeyPath = join(baseDir, "id_ed25519");
export const sshConfigPath = join(baseDir, "ssh_config");
export const knownHostsPath = join(baseDir, "known_hosts");
export const binDir = join(baseDir, "bin");

// What `intentic-sync setup` writes and the other commands read back. sshHostname is what the daemon returned
// on enrollment — the tunnel host Mutagen reaches; sandboxId namespaces the ssh alias + Mutagen session.
export interface SyncConfig {
    readonly sandboxUrl: string;
    readonly sandboxId: string;
    readonly sshHostname: string;
    readonly localDir: string;
}

export const readConfig = async (): Promise<SyncConfig> => JSON.parse(await readFile(configPath, "utf8")) as SyncConfig;

export const writeConfig = async (config: SyncConfig): Promise<void> => {
    await mkdir(baseDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, undefined, 2), "utf8");
};
