import { readFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { livePid } from "@intentic/local-agent";
import type { MachinePairing, MachinePort, MachineReport } from "@intentic/sandbox-contract";
import { mirrorHeartbeatPath, mirrorPidPath, type Pairing, readState, type SyncState } from "./config.js";
import { readSessionState, sessionName } from "./mutagen.js";
import { SYNC_VERSION } from "./version.js";

/* THE MACHINE REPORT — everything this agent knows about the computer it runs on, in one shape.
 *
 * It exists because the answer used to live only in `intentic-sync status`'s printed output, on a terminal that
 * the two audiences who most need it do not have open: the desktop app (whose whole premise is not needing one)
 * and the Desktop sync card in the browser, which could say a machine was enrolled but not which folder it synced
 * into, which ports it held, or whether the watcher behind all of it was still alive.
 *
 * So the report is the product and the printed status is one rendering of it — `status` formats this, `status
 * --json` emits it, the mirror watcher posts it, and a `host` capability reads it back over run_command. One
 * producer is what keeps those from drifting, the same argument the desktop app makes for spawning connect.sh
 * instead of reimplementing it.
 *
 * What is NOT here is deliberate: no docker scan. Enumerating a machine's containers is the reader's job (the
 * desktop app already does it natively; the daemon does it through the host capability), and a sync agent
 * volunteering the list of a machine's OTHER sandboxes to one of them is the disclosure this design avoids by
 * construction rather than by remembering to filter. `sandboxes` is therefore always empty here, and filled in
 * by whoever is trusted to. */

/* The watcher's liveness — the PID it claims AND the last pass it finished, because only the pair is an answer.
 * A watcher whose loop died still holds its pidfile (its tunnel listeners keep the process alive), so `running`
 * on its own has twice now reported a stopped mirror, a stopped git bridge and file syncs that were never created
 * as a healthy machine. The stamp is what makes that visible to every reader at once: this terminal, the Desktop
 * sync card, and the Computers view all read this shape.
 *
 * An unreadable or unparseable stamp is `undefined` — "this watcher has not finished a pass yet", which is true
 * of a watcher that just started and of one that has never ticked, and both are better read as not-yet-known than
 * as a number. Read from the pidfile's neighbour the same way every other cross-process caller reads it; inlined
 * rather than imported from mirror.ts, which imports this module to post the report. */
const lastTick = async (): Promise<number | undefined> => {
    const raw = await readFile(mirrorHeartbeatPath, "utf8").catch(() => undefined);
    const stamped = Number(raw?.trim());
    return Number.isFinite(stamped) && stamped > 0 ? stamped : undefined;
};

const watcherState = async (): Promise<MachineReport["watcher"]> => {
    const [pid, lastTickAt] = await Promise.all([livePid(mirrorPidPath), lastTick()]);
    return { running: pid !== undefined, pid, lastTickAt };
};

const pairingReport = (mutagen: string | undefined, pairing: Pairing): MachinePairing => {
    // A mirror-only enrollment has no file sync at all, so there is no session to ask about — its absent status
    // is a fact about the mode, not a failure to read one.
    if (pairing.mode !== "sync" || mutagen === undefined) {
        return { sandboxId: pairing.sandboxId, mode: pairing.mode, localDir: pairing.localDir };
    }
    /* A sync pairing with NO session is the state this report exists to make visible, so it is carried as the
     * ABSENCE of a status rather than as some word for it: nothing is syncing that folder, whatever the ports and
     * the watcher rows say. Every reader renders that one way (see pairingLine) instead of each inventing a
     * default. A session that exists always has a status — readSessionState resolves Mutagen's omitted zero. */
    const session = readSessionState(mutagen, sessionName(pairing.sandboxId));
    return {
        sandboxId: pairing.sandboxId,
        mode: pairing.mode,
        localDir: pairing.localDir,
        mutagenStatus: session.status,
        conflicts: session.conflicts,
        paused: session.paused,
    };
};

// Both halves of one pairing's port picture, as the last reconcile left them: what reached localhost, and what
// wanted to and could not. The second half is the one nothing has ever been able to show.
const portRows = (pairing: Pairing): MachinePort[] => [
    ...(pairing.mirroredPorts ?? []).map((port): MachinePort => ({
        port: port.port,
        host: port.host,
        sandboxId: pairing.sandboxId,
        state: `mirrored`,
        command: port.command,
    })),
    ...(pairing.skippedPorts ?? []).map((port): MachinePort => ({
        port: port.port,
        host: port.host,
        sandboxId: pairing.sandboxId,
        state: port.heldBy === undefined ? `busy` : `held-by-sandbox`,
        heldBy: port.heldBy,
        command: port.command,
    })),
];

/* Build the report. `mutagen` is the resolved binary path, or undefined to skip the session reads — a caller that
 * has no Mutagen (or does not want to pay for the per-session spawns) still gets the pairings, folders, ports and
 * watcher, which is most of the answer. `capturedAt` is stamped here because this is where the reading happens;
 * everything downstream ages the report against it rather than against its own arrival time. */
export const buildReport = (state: SyncState, mutagen: string | undefined, watcher: MachineReport["watcher"], capturedAt: number): MachineReport => ({
    hostname: hostname(),
    os: platform(),
    agents: { sync: SYNC_VERSION },
    sandboxes: [],
    pairings: state.pairings.map((pairing) => pairingReport(mutagen, pairing)),
    ports: state.pairings.flatMap(portRows),
    watcher,
    capturedAt,
});

// The report for this machine right now — the one entry point every carrier uses.
export const machineReport = async (mutagen: string | undefined): Promise<MachineReport> =>
    buildReport(await readState(), mutagen, await watcherState(), Date.now());

/* One pairing's slice, for POSTing to the sandbox that pairing belongs to. This is the disclosure rule as code:
 * a report crossing the network to a sandbox carries THAT sandbox's pairing and ports, never its siblings' — and
 * a `mirror` enrollment (a collaborator's own laptop, which the sandbox's owner does not own) drops the local
 * folder with them, so mirroring a dev-server port never hands over a map of someone's machine.
 *
 * The whole-machine report stays whole-machine only where it is read by the machine's own user: `status`, and the
 * desktop app.
 *
 * Dropping the folder needs no step of its own: a "mirror" pairing never has a localDir to begin with (config.ts
 * sets it only for mode "sync"), so scoping to the one pairing is what withholds it. */
export const scopedReport = (report: MachineReport, sandboxId: string): MachineReport => ({
    ...report,
    pairings: report.pairings.filter((pairing) => pairing.sandboxId === sandboxId),
    ports: report.ports.filter((port) => port.sandboxId === sandboxId),
});
