import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentHome, writeSecretFile } from "@intentic/local-agent";
import type { PortSummary } from "@intentic/sandbox-contract";

// Everything the agent persists lives under ~/.intentic/sync — the config it was set up with, the SSH keypair
// Mutagen authenticates with, and the known_hosts its ssh writes. The one credential besides the key is the
// enrollment-minted sync token (scoped daemon-side to reading the ports list). The directory and the 0600 floor
// come from @intentic/local-agent: this file used to write the token with the process umask, because it was
// copied from the host agent's before that floor existed and nothing afterwards compared the two.
const home = agentHome("sync");
export const baseDir = home.dir;
const configPath = home.configPath;
export const sshKeyPath = join(baseDir, "id_ed25519");
export const knownHostsPath = join(baseDir, "known_hosts");
export const binDir = join(baseDir, "bin");

// The one thing that does NOT live under baseDir: the ssh-config fragment Mutagen's ssh reads. It sits in
// ~/.ssh so the user's own config can pull it in by a RELATIVE name — the only include spelling every OpenSSH
// build resolves identically, and the whole reason Windows sync works at all (see ssh.ts).
export const sshDir = join(homedir(), ".ssh");
export const sshConfigName = "intentic-sync.conf";
export const sshConfigPath = join(sshDir, sshConfigName);
export const userSshConfigPath = join(sshDir, "config");
// The mirror watcher's liveness pidfile + its append-only log (the watcher runs detached, so stdout goes nowhere).
export const mirrorPidPath = join(baseDir, "mirror.pid");
export const mirrorLogPath = join(baseDir, "mirror.log");

// One mirrored port: the local bind (same number) + the loopback address the sandbox listener answers at —
// stored so the watch reconcile can leave unchanged forwards untouched and recreate one whose family moved.
// `command` rides along for the report only: what the port is ("node …/vite") is the difference between a row a
// user recognises and a bare number, and the reconcile is the one place that ever sees it.
export interface MirroredPort {
    readonly port: number;
    readonly host: PortSummary["host"];
    readonly command?: string | undefined;
}

/* A port the sandbox serves that this machine did NOT put on localhost, and why. Persisted for exactly one
 * reason: it is the only record that the port was ever wanted. The reconcile decides this every tick and writes
 * it to mirror.log, so a dev server that is simply missing from localhost — because a sibling sandbox paired
 * first, or because something local already holds the number — has always been diagnosable only by reading an
 * append-only log on the machine. `heldBy` names the sandbox that won; its absence means a foreign process did. */
export interface SkippedPort {
    readonly port: number;
    readonly host: PortSummary["host"];
    readonly heldBy?: string | undefined;
    readonly command?: string | undefined;
}

// What the daemon granted this machine: "sync" = bidirectional file sync of /work + port mirroring (single
// holder), "mirror" = port mirroring only (unlimited collaborators). Decided by the pairing the enroll redeemed.
export type SyncMode = "sync" | "mirror";

/* One paired sandbox. sandboxId namespaces the ssh alias, the Mutagen sessions and the loopback port the SSH
 * transport listens on, and is the KEY: it comes from the sandbox's own URL host, so it identifies the sandbox
 * across re-pairings. syncToken is the enrollment-minted credential — for the daemon's GET /ports (what `mirror`
 * reconciles against), for the self-revoke on uninstall, AND for the SSH transport itself (tunnel.ts), which is
 * why a pairing without one can do nothing but exist. localDir is set only for mode "sync" (mirror-only has no
 * file sync). mirroredPorts is the set of Mutagen forward sessions the last reconcile left alive — the baseline,
 * so vanished ports get terminated; skippedPorts is its negative, the ports that same reconcile wanted and could
 * not have.
 *
 * There is no sshHostname any more. The daemon used to answer enrollment with a tunnel host for Mutagen to dial;
 * the transport now runs over the sandbox's own HTTPS surface, so the address is derived from sandboxUrl and the
 * port from sandboxId, and there is nothing left for the daemon to tell us (see tunnel.ts). */
export interface Pairing {
    readonly sandboxUrl: string;
    readonly sandboxId: string;
    readonly mode: SyncMode;
    readonly localDir?: string;
    readonly syncToken?: string;
    readonly mirroredPorts?: readonly MirroredPort[];
    readonly skippedPorts?: readonly SkippedPort[];
}

/* Every pairing this machine holds — a LIST, because one machine legitimately runs a fleet of sandboxes.
 *
 * This file used to hold exactly one pairing, and `setup` therefore treated pairing a new sandbox as replacing a
 * dead one: it overwrote the whole ssh fragment, tore down every forward on the machine, forgot the old folder,
 * and terminated its file-sync session. That premise ("an earlier pairing's sandbox is gone") is false the moment
 * two sandboxes run side by side — installing the desktop app next to a CLI-started sandbox silently stopped
 * syncing the folder the user was working in, with both `intentic-sync status` and the evicted sandbox's own
 * Desktop-sync card still reporting a healthy sync. Keyed by sandboxId, a second pairing is an ADDITION. */
export interface SyncState {
    readonly pairings: readonly Pairing[];
}

// The state as written. A missing file is an EMPTY pairing list rather than an error: "nothing has ever been
// paired here" is a state every caller has a real answer for — `status` prints none, `uninstall` still strips the
// agent's residency, the watcher exits — so making them each catch an ENOENT bought nothing. A file that EXISTS
// and won't parse is a genuine fault and propagates.
export const readState = async (): Promise<SyncState> => {
    const raw = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    });
    return raw === undefined ? { pairings: [] } : (JSON.parse(raw) as SyncState);
};

/* Read-modify-write the pairing list. Every mutation goes through here and re-reads immediately beforehand, so a
 * caller mutates what is on disk now rather than a state it built earlier — two processes write this file for
 * different reasons (`setup` adds a pairing; the resident watcher stamps mirroredPorts onto the ones already
 * there), and the mutations are expected to name only what they change.
 *
 * This is NOT cross-process exclusion, and doesn't pretend to be: `setup` still stops the watcher before writing,
 * which is what actually keeps those two apart. What the narrow window plus targeted mutations buy is the size of
 * the worst case — a lost update costs one tick's port baseline instead of a sibling's whole pairing. */
export const updateState = async (mutate: (state: SyncState) => SyncState): Promise<void> =>
    await writeSecretFile(configPath, baseDir, JSON.stringify(mutate(await readState()), undefined, 2));

// Add a pairing, or replace the one already held for that sandbox (re-running setup rotates its token). Every
// OTHER pairing survives untouched — the whole point of the list.
export const upsertPairing = async (pairing: Pairing): Promise<void> =>
    await updateState((state) => ({ pairings: [...state.pairings.filter((held) => held.sandboxId !== pairing.sandboxId), pairing] }));

export const removePairing = async (sandboxId: string): Promise<void> =>
    await updateState((state) => ({ pairings: state.pairings.filter((held) => held.sandboxId !== sandboxId) }));
