import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeSecretFile } from "@intentic/local-agent";
import type { PortSummary } from "@intentic/sandbox-contract";
import { baseDir } from "../config.js";

// Everything the sync half persists: its pairing list (in its own file, separate from the device half's), the
// SSH keypair Mutagen authenticates with, and the known_hosts its ssh writes, plus the enrollment-minted sync
// token. The 0600 floor comes from @intentic/local-agent.
const configPath = join(baseDir, "sync.json");
export const sshKeyPath = join(baseDir, "id_ed25519");
export const knownHostsPath = join(baseDir, "known_hosts");
export const binDir = join(baseDir, "bin");

// The one thing that does NOT live under baseDir: the ssh-config fragment Mutagen's ssh reads. It sits in
// ~/.ssh so the user's own config can pull it in by a relative name, the only include spelling every OpenSSH
// build resolves identically.
export const sshDir = join(homedir(), ".ssh");
export const sshConfigName = "intentic-machine.conf";
export const sshConfigPath = join(sshDir, sshConfigName);
export const userSshConfigPath = join(sshDir, "config");

// Where `mutagen daemon start` writes when we are the ones starting it at logon (Windows): Mutagen's own
// registration is a console command in the Run key, which flashes a terminal at every boot; ours goes through
// the launcher stub instead.
export const mutagenDaemonLogPath = join(baseDir, "mutagen-daemon.log");

// When the watcher last completed a pass; a live pid is not the same fact. The watcher holds its tunnel
// listeners on the event loop, so a rejection that escapes it leaves the process alive while the loop is gone:
// the pidfile stays claimed and mirroring, the git bridge and file sync are silently stopped. Stamped at the
// END of each tick, so a stamp older than a couple of polls reads as stalled (see report.ts).
export const mirrorHeartbeatPath = join(baseDir, "mirror.tick");

// One mirrored port: the local bind (same number) + the loopback address the sandbox listener answers at,
// stored so the reconcile can leave unchanged forwards untouched. `command` rides along for the report only.
export interface MirroredPort {
    readonly port: number;
    readonly host: PortSummary["host"];
    readonly command?: string | undefined;
}

// A port the sandbox serves that this machine did NOT put on localhost, and why: the only record that the port
// was ever wanted. `heldBy` names the sandbox that won; its absence means a foreign process did.
export interface SkippedPort {
    readonly port: number;
    readonly host: PortSummary["host"];
    readonly heldBy?: string | undefined;
    readonly command?: string | undefined;
}

// What the daemon granted this machine: "sync" = bidirectional file sync of /work + port mirroring (single
// holder), "mirror" = port mirroring only (unlimited collaborators).
export type SyncMode = "sync" | "mirror";

// One paired sandbox. sandboxId namespaces the ssh alias, the Mutagen sessions and the loopback port, and is
// the key. syncToken is the enrollment-minted credential for GET /ports, the self-revoke on uninstall, and the
// SSH transport itself; a pairing without one can do nothing but exist. mirroredPorts/skippedPorts are the last
// reconcile's baseline and its negative. fileSyncAutoPaused marks a pause the watcher itself applied after an
// hour unreachable, distinct from a person's `pause`, which the watcher never undoes.
export interface Pairing {
    readonly sandboxUrl: string;
    readonly sandboxId: string;
    readonly mode: SyncMode;
    readonly localDir?: string;
    readonly syncToken?: string;
    readonly mirroredPorts?: readonly MirroredPort[];
    readonly skippedPorts?: readonly SkippedPort[];
    readonly mirrorOff?: boolean | undefined;
    readonly fileSyncAutoPaused?: boolean | undefined;
}

// Every pairing this machine holds, a LIST: one machine legitimately runs a fleet of sandboxes. This file used
// to hold exactly one pairing, so a second `setup` overwrote the ssh fragment, tore down every forward, and
// terminated the first sandbox's file-sync session. Keyed by sandboxId, a second pairing is an addition.
export interface SyncState {
    readonly pairings: readonly Pairing[];
}

// The state as written. A missing file is an EMPTY pairing list, not an error: every caller has a real answer
// for "nothing has ever been paired here". A file that EXISTS and won't parse is a genuine fault and propagates.
export const readState = async (): Promise<SyncState> => {
    const raw = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    });
    if (raw === undefined) {
        return { pairings: [] };
    }
    const parsed = JSON.parse(raw) as Partial<SyncState> | undefined;
    return { pairings: Array.isArray(parsed?.pairings) ? parsed.pairings : [] };
};

// Read-modify-write the pairing list: every mutation re-reads first, so a caller mutates what is on disk now.
// This is NOT cross-process exclusion (`setup` stops the watcher before writing, which is what keeps them
// apart); it bounds a lost update to one tick's port baseline rather than a sibling's whole pairing.
export const updateState = async (mutate: (state: SyncState) => SyncState): Promise<void> =>
    await writeSecretFile(configPath, baseDir, JSON.stringify(mutate(await readState()), undefined, 2));

// Add a pairing, or replace the one already held for that sandbox (re-running setup rotates its token). Every
// other pairing survives untouched.
export const upsertPairing = async (pairing: Pairing): Promise<void> =>
    await updateState((state) => ({ pairings: [...state.pairings.filter((held) => held.sandboxId !== pairing.sandboxId), pairing] }));

export const removePairing = async (sandboxId: string): Promise<void> =>
    await updateState((state) => ({ pairings: state.pairings.filter((held) => held.sandboxId !== sandboxId) }));

// Port mirroring, off. Lives here because the localhost being written to is here: mirroring is the one half
// that changes the device it runs on, and until now the only ways to stop it were unpairing the sandbox or
// revoking the enrollment for every machine at once. Local and durable so it survives a restart and holds while
// the sandbox is unreachable; scoped to one pairing, since a device mirroring three sandboxes has three answers.
export const setMirrorOff = async (sandboxId: string, off: boolean): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, mirrorOff: off ? true : undefined } : held)),
    }));

export const setFileSyncAutoPaused = async (sandboxId: string, paused: boolean): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, fileSyncAutoPaused: paused ? true : undefined } : held)),
    }));
