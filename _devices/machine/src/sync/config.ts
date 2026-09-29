import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { homeDir, writeSecretFile } from "@intentic/local-agent";
import { type PortSkipReason, type PortSummary, projectDirNameOf } from "@intentic/sandbox-contract";
import { z } from "zod";
import { baseDir } from "../config.js";

// Everything the sync half persists: its pairing list (in its own file, separate from the device half's), the
// SSH keypair Mutagen authenticates with, and the known_hosts its ssh writes, plus the enrollment-minted sync
// token. The 0600 floor comes from @intentic/local-agent.
const configPath = join(baseDir, "sync.json");
export const sshKeyPath = join(baseDir, "id_ed25519");
export const knownHostsPath = join(baseDir, "known_hosts");

// The one thing that does NOT live under baseDir: the ssh-config fragment Mutagen's ssh reads. It sits in
// ~/.ssh so the user's own config can pull it in by a relative name, the only include spelling every OpenSSH
// build resolves identically.
export const sshDir = join(homeDir(), ".ssh");
export const sshConfigName = "intentic-machine.conf";
export const sshConfigPath = join(sshDir, sshConfigName);
export const userSshConfigPath = join(sshDir, "config");

// Where `mutagen daemon start` writes when we are the ones starting it at logon (Windows): Mutagen's own
// registration is a console command in the Run key, which flashes a terminal at every boot; ours goes through
// the launcher stub instead.
export const mutagenDaemonLogPath = join(baseDir, "mutagen-daemon.log");

// When the watcher last completed a pass; a live pid is not the same fact. The watcher holds its tunnel
// listeners on the event agent, so a rejection that escapes it leaves the process alive while the agent is gone:
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
// was ever wanted. `reason` is what the report renders; `heldBy` names the sandbox that won, and is set only when
// the reason is that one.
export interface SkippedPort {
    readonly port: number;
    readonly host: PortSummary["host"];
    readonly reason: PortSkipReason;
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
// hour unreachable, distinct from a person's `pause`, which the watcher never undoes. fileSyncSwapPaused marks the
// pause it applies while the sandbox is swapped on this machine (swap-pause.ts), kept on disk so an agent restarted
// mid-swap still lifts it. autoHealOff stops this agent
// clearing the build output it left inside directories the sandbox deleted (residue.ts); it is off by default because
// what that removes is content the session already ignores, which a build puts back. ignoredPorts is mirrorOff's
// per-port form: numbers this device is never to take, which is a standing choice and not a reading, so nothing the
// watcher learns ever rewrites it. remoteDir is which sandbox folder localDir holds, /work itself when absent (every
// pairing made before it existed); `project` marks the owner's own folder synced into `/work/<name>`, which carries
// no state backup and no git bridge (`isProjectPairing`), and the two only ever come together (`pairingProblem`).
// `direction` is which way a project's files flow (`projectDirection`), and means nothing on any other pairing.
export interface Pairing {
    readonly sandboxUrl: string;
    readonly sandboxId: string;
    readonly mode: SyncMode;
    readonly localDir?: string;
    readonly syncToken?: string;
    readonly mirroredPorts?: readonly MirroredPort[];
    readonly skippedPorts?: readonly SkippedPort[];
    readonly ignoredPorts?: readonly number[];
    readonly mirrorOff?: boolean | undefined;
    readonly fileSyncAutoPaused?: boolean | undefined;
    readonly fileSyncSwapPaused?: boolean | undefined;
    readonly autoHealOff?: boolean | undefined;
    readonly remoteDir?: string | undefined;
    readonly project?: true | undefined;
    readonly direction?: ProjectDirection | undefined;
}

// COPY-FIRST unless the owner opted into two-way. "to-sandbox": the folder flows one way into the sandbox, and what an
// agent changes there comes back only through `sync bring-back`, after a restore point; "both": the two-way sync every
// other pairing has.
export type ProjectDirection = "to-sandbox" | "both";

// Read leniently, and never held to a schema the way the placement below is: absent is every project made before the
// field existed, and a value this build has no word for (a later release's) is read as the protective default rather
// than refusing the whole file, which would stop every pairing's sync.
export const projectDirection = (pairing: Pick<Pairing, "direction">): ProjectDirection => (pairing.direction === "both" ? "both" : "to-sandbox");

// The sandbox folder a pairing syncs.
export const pairingRemoteDir = (pairing: Pick<Pairing, "remoteDir">): string => pairing.remoteDir ?? WORKSPACE_ROOT;

// A PROJECT PAIRING syncs a folder that is the owner's own project, not a copy of the workspace: nothing of the
// sandbox's (its state, its git history) may ever be written into it. Every reader that would write something there
// asks this first.
export const isProjectPairing = (pairing: Pick<Pairing, "project">): boolean => pairing.project === true;

// What is wrong with a pairing's remote side, or undefined. `remoteDir` is where Mutagen writes in the sandbox and,
// through the two-way session, what lands in this device's folder, so it is held to exactly two shapes: /work, or
// one project folder directly under it. A project pairing must be the second (its ignore list no longer shields the
// sandbox's state dir, which only /work holds), and the second is only ever a project's.
export const pairingProblem = (pairing: Pick<Pairing, "remoteDir" | "project">): string | undefined => {
    const inProject = pairing.remoteDir !== undefined && projectDirNameOf(pairing.remoteDir) !== undefined;
    if (pairing.remoteDir !== undefined && pairing.remoteDir !== WORKSPACE_ROOT && !inProject) {
        return `remoteDir ${JSON.stringify(pairing.remoteDir)} is neither ${WORKSPACE_ROOT} nor ${WORKSPACE_ROOT}/<name> (a name starting with a letter or digit, of letters, digits, ".", "_" and "-", and not one the sandbox keeps for itself)`;
    }
    if (isProjectPairing(pairing) && !inProject) {
        return `is a project pairing but syncs ${pairingRemoteDir(pairing)}, not a project folder under ${WORKSPACE_ROOT}`;
    }
    if (!isProjectPairing(pairing) && inProject) {
        return `syncs ${pairingRemoteDir(pairing)}, which only a project pairing may`;
    }
    return undefined;
};

// The two fields that decide where a pairing's files go, parsed where the file is read; the rest of a pairing is taken
// as this agent wrote it, as it always has been.
const PlacementSchema = z.object({
    sandboxId: z.string(),
    remoteDir: z.string().optional(),
    project: z.literal(true).optional(),
});

// Every pairing, or the first that is wrong, as the one error it is. A file with a pairing like that is refused whole,
// read or written, rather than served in part: a pairing that syncs somewhere this agent cannot vouch for must not
// sync at all, and dropping it would be persisted by the next write as if the owner had unpaired it.
const assertPairings = (pairings: readonly unknown[]): void => {
    for (const raw of pairings) {
        const placement = PlacementSchema.safeParse(raw);
        const problem = placement.success ? pairingProblem(placement.data) : `is malformed (${placement.error.issues.map((issue) => issue.message).join("; ")})`;
        if (problem !== undefined) {
            throw new SyntaxError(`${configPath}: the pairing for ${placement.success ? placement.data.sandboxId : "a sandbox"} ${problem}`);
        }
    }
};

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
    const parsed = JSON.parse(raw) as Partial<SyncState> | null;
    // Another shape is as unreadable as bad bytes: "no pairings" stops sync and every writer would persist it.
    if (!Array.isArray(parsed?.pairings)) {
        throw new SyntaxError(`${configPath} has no "pairings" list`);
    }
    assertPairings(parsed.pairings);
    return { pairings: parsed.pairings };
};

// Read-modify-write the pairing list: every mutation re-reads first, so a caller mutates what is on disk now.
// This is NOT cross-process exclusion (`setup` stops the watcher before writing, which is what keeps them
// apart); it bounds a lost update to one tick's port baseline rather than a sibling's whole pairing.
export const updateState = async (mutate: (state: SyncState) => SyncState): Promise<void> => {
    const next = mutate(await readState());
    assertPairings(next.pairings);
    await writeSecretFile(configPath, baseDir, JSON.stringify(next, undefined, 2));
};

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

// One port this device is not to take, the per-port form of the switch above. Machine-side because the conflict is
// the device's: a number is contended on THIS localhost and free on the next one, so the same sandbox mirrors it
// everywhere else. Stored sorted and deduped, since it is read as a set and shown as a list.
export const setPortIgnored = async (sandboxId: string, port: number, ignored: boolean): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => {
            if (held.sandboxId !== sandboxId) {
                return held;
            }
            // Destructured away rather than set to undefined: the key is absent when nothing is ignored, so a
            // pairing carrying the resting state carries no field for it either.
            const { ignoredPorts = [], ...rest } = held;
            const kept = ignoredPorts.filter((held_port) => held_port !== port);
            const next = ignored ? [...kept, port].toSorted((a, b) => a - b) : kept;
            return next.length === 0 ? rest : { ...rest, ignoredPorts: next };
        }),
    }));

// Clearing derived residue, off. Local and durable for the same reason mirroring's switch is: it decides what this
// agent may delete on THIS device, so it has to hold through a restart and while the sandbox is unreachable.
export const setAutoHealOff = async (sandboxId: string, off: boolean): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, autoHealOff: off ? true : undefined } : held)),
    }));

export const setFileSyncAutoPaused = async (sandboxId: string, paused: boolean): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, fileSyncAutoPaused: paused ? true : undefined } : held)),
    }));

export const setFileSyncSwapPaused = async (sandboxId: string, paused: boolean): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, fileSyncSwapPaused: paused ? true : undefined } : held)),
    }));

// Stored spelled out rather than as an absent key: the file says which way the owner chose. An agent older than the
// field carries it through every write but a `setup` (each spreads the pairing it read), and its drift check never
// compared the sync mode, so it keeps the copy-first session it finds unless something else about that session drifted.
export const setProjectDirection = async (sandboxId: string, direction: ProjectDirection): Promise<void> =>
    await updateState((state) => ({
        pairings: state.pairings.map((held) => (held.sandboxId === sandboxId ? { ...held, direction } : held)),
    }));
