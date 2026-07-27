import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PortSummary } from "@intentic/sandbox-contract";

// Everything the agent persists lives under ~/.intentic/sync — the config it was set up with, the SSH keypair
// Mutagen authenticates with, and the ssh config/known_hosts Mutagen's ssh reads. The one credential besides
// the key is the enrollment-minted sync token (scoped daemon-side to reading the ports list).
export const baseDir = join(homedir(), ".intentic", "sync");
const configPath = join(baseDir, "config.json");
export const sshKeyPath = join(baseDir, "id_ed25519");
export const sshConfigPath = join(baseDir, "ssh_config");
export const knownHostsPath = join(baseDir, "known_hosts");
export const binDir = join(baseDir, "bin");
// The mirror watcher's liveness pidfile + its append-only log (the watcher runs detached, so stdout goes nowhere).
export const mirrorPidPath = join(baseDir, "mirror.pid");
export const mirrorLogPath = join(baseDir, "mirror.log");

// Where a command writes its user-facing progress. Every entry point owns its sink (stdout for an interactive
// command, the timestamped mirror.log for the detached watcher), so the code underneath takes one of these
// rather than writing anywhere itself.
export type Log = (message: string) => void;

// One mirrored port: the local bind (same number) + the loopback address the sandbox listener answers at —
// stored so the watch reconcile can leave unchanged forwards untouched and recreate one whose family moved.
export interface MirroredPort {
    readonly port: number;
    readonly host: PortSummary["host"];
}

// What the daemon granted this machine: "sync" = bidirectional file sync of /work + port mirroring (single
// holder), "mirror" = port mirroring only (unlimited collaborators). Decided by the pairing the enroll redeemed.
export type SyncMode = "sync" | "mirror";

// What `intentic-sync setup` writes and the other commands read back. sshHostname is what the daemon returned
// on enrollment — the tunnel host Mutagen reaches; sandboxId namespaces the ssh alias + Mutagen sessions.
// syncToken is the enrollment-minted credential for the daemon's GET /ports (what `mirror` reconciles against)
// + self-revoke on uninstall. localDir is set only for mode "sync" (mirror-only has no file sync). mirroredPorts
// is the set of Mutagen forward sessions the last reconcile left alive — the baseline, so vanished ports get terminated.
export interface SyncConfig {
    readonly sandboxUrl: string;
    readonly sandboxId: string;
    readonly sshHostname: string;
    readonly mode: SyncMode;
    readonly localDir?: string;
    readonly syncToken?: string;
    readonly mirroredPorts?: readonly MirroredPort[];
}

export const readConfig = async (): Promise<SyncConfig> => JSON.parse(await readFile(configPath, "utf8")) as SyncConfig;

export const writeConfig = async (config: SyncConfig): Promise<void> => {
    await mkdir(baseDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(config, undefined, 2), "utf8");
};
