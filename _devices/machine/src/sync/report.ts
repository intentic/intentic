import { readFile } from "node:fs/promises";
import { hostname, platform } from "node:os";
import { livePidRecord } from "@intentic/local-agent";
import type { DeviceAgent, DevicePairing, DevicePort, DeviceReport } from "@intentic/sandbox-contract";
import { runPidPath } from "../config.js";
import { installedBuild } from "../installed.js";
import { mirrorHeartbeatPath, type Pairing, readState, type SyncState } from "./config.js";
import { backupSessionName, readSessionState, sessionName } from "./mutagen.js";

// Everything this agent knows about the device, in one shape fed to `status`, `status --json`, the mirror
// watcher's post, and the host capability, so they can't drift. No docker scan: enumerating a machine's containers
// is the disclosure this design avoids; `sandboxes` is always empty here, filled in by whoever is trusted to.

// Liveness needs both the held pid and the last finished pass: a dead loop still holds its pidfile (tunnel
// listeners keep it alive), so `running` alone can misreport a stopped mirror as healthy. Undefined means no pass has
// finished yet.
const lastTick = async (): Promise<number | undefined> => {
    const raw = await readFile(mirrorHeartbeatPath, "utf8").catch(() => undefined);
    const stamped = Number(raw?.trim());
    return Number.isFinite(stamped) && stamped > 0 ? stamped : undefined;
};

// Two facts, not one: the loop's own build (from its pidfile note) and the build installed on disk, since a
// swapped binary leaves a live loop running the old code. `installed` is passed in because it costs a syscall/spawn.
const agentState = async (installed: string | undefined): Promise<DeviceAgent> => {
    const [resident, lastTickAt] = await Promise.all([livePidRecord(runPidPath), lastTick()]);
    return { running: resident !== undefined, pid: resident?.pid, build: resident?.note, installed, lastTickAt };
};

const pairingReport = (mutagen: string | undefined, pairing: Pairing): DevicePairing => {
    // Stated on every pairing rather than inferred from an empty port list: "nothing is listening" and "this device
    // was told not to" look identical otherwise, and only one has anything for a reader to do.
    const mirroring = pairing.mirrorOff === true ? "off" : "on";
    // A mirror-only enrollment has no file sync to ask about; the absent status is a fact about the mode, not a
    // failed read.
    if (pairing.mode !== "sync" || mutagen === undefined) {
        return { sandboxId: pairing.sandboxId, mode: pairing.mode, localDir: pairing.localDir, mirroring };
    }
    // A sync pairing with no session is carried as the absence of a status, not a word for it, so every reader
    // renders it the same way instead of inventing a default. readSessionState resolves Mutagen's omitted zero.
    const session = readSessionState(mutagen, sessionName(pairing.sandboxId));
    // The state backup reads the same way: no status means no session, so the sandbox is the only copy of its state.
    const backup = readSessionState(mutagen, backupSessionName(pairing.sandboxId));
    return {
        sandboxId: pairing.sandboxId,
        mode: pairing.mode,
        localDir: pairing.localDir,
        mirroring,
        mutagenStatus: session.status,
        conflicts: session.conflicts,
        // The stuck paths, not just a count: a number names nothing to look at.
        conflictedPaths: session.conflictedPaths,
        paused: session.paused,
        backupStatus: backup.status,
    };
};

// Both halves of one pairing's port picture: what reached localhost, and what wanted to but couldn't.
const portRows = (pairing: Pairing): DevicePort[] => [
    ...(pairing.mirroredPorts ?? []).map((port): DevicePort => ({
        port: port.port,
        host: port.host,
        sandboxId: pairing.sandboxId,
        state: `mirrored`,
        command: port.command,
    })),
    ...(pairing.skippedPorts ?? []).map((port): DevicePort => ({
        port: port.port,
        host: port.host,
        sandboxId: pairing.sandboxId,
        state: port.heldBy === undefined ? `busy` : `held-by-sandbox`,
        heldBy: port.heldBy,
        command: port.command,
    })),
];

// `mutagen` undefined skips the session reads but still returns pairings, folders, ports and the agent.
// `capturedAt` is stamped here, where the reading happens; downstream ages the report against it.
export const buildReport = (state: SyncState, mutagen: string | undefined, agent: DeviceAgent, capturedAt: number): DeviceReport => ({
    hostname: hostname(),
    os: platform(),
    sandboxes: [],
    pairings: state.pairings.map((pairing) => pairingReport(mutagen, pairing)),
    ports: state.pairings.flatMap(portRows),
    agent,
    capturedAt,
});

// The report for this machine right now, the one entry point every carrier uses.
export const deviceReport = async (mutagen: string | undefined): Promise<DeviceReport> =>
    buildReport(await readState(), mutagen, await agentState(installedBuild()), Date.now());

// One pairing's slice for posting to its sandbox: only that pairing and its ports cross the network. A `mirror`
// enrollment's folder drops too, since it never had a localDir to begin with.
export const scopedReport = (report: DeviceReport, sandboxId: string): DeviceReport => ({
    ...report,
    pairings: report.pairings.filter((pairing) => pairing.sandboxId === sandboxId),
    ports: report.ports.filter((port) => port.sandboxId === sandboxId),
});
