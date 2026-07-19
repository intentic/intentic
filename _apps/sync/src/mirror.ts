import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import { type MirroredPort, mirrorLogPath, mirrorPidPath, readConfig, type SyncConfig, writeConfig } from "./config.js";
import { ensureMutagen, forwardSessionName, mutagenForwardArgs, runMutagen } from "./mutagen.js";
import { sshAlias } from "./ssh.js";

// Port mirroring: every WORKSPACE port listening in the sandbox is bound to the SAME port on this machine's
// localhost, over Mutagen TCP forward sessions riding the enrolled SSH transport. This is what makes remote
// development feel local — a frontend baked with `https://localhost:6480` just works (cookies + CORS included)
// because localhost IS serving it. A resident watcher polls the daemon's /ports so a dev server started later
// (Vite grabbing a fresh random port) is mirrored within a poll, with no user action.

export type Log = (message: string) => void;

// How often the watcher re-reads the sandbox's ports. Fast enough that a just-started dev server is reachable
// before the user finishes alt-tabbing to the browser; slow enough to be free.
const POLL_MS = 5000;

// The sandbox's currently-listening WORKSPACE ports (dev servers, terminal processes, published containers) —
// what the reconcile drives from. Authenticated by the enrollment-minted sync token, which the daemon scopes
// to exactly this read. System ports (the sandbox's own machinery) are filtered out and never mirrored.
export const fetchWorkspacePorts = async (sandboxUrl: string, syncToken: string): Promise<PortSummary[]> => {
    const response = await fetch(`${sandboxUrl.replace(/\/$/, "")}/ports`, { headers: { "x-intentic-sync": syncToken } });
    if (response.status === 401 || response.status === 403) {
        throw new Error("the sandbox rejected the sync token — click “Enable desktop sync” in your browser and re-run setup to mint a fresh one.");
    }
    if (!response.ok) {
        throw new Error(`reading the sandbox's ports failed (${response.status}): ${await response.text()}`);
    }
    return PortsListSchema.parse(await response.json()).ports.filter((port) => port.kind === "workspace");
};

// Whether the local loopback port is free to bind — checked after terminating our OWN prior forward (which held
// it), so a remaining conflict is genuinely foreign (something else on this machine already owns the port).
const localPortFree = (port: number): Promise<boolean> =>
    new Promise((resolvePort) => {
        const probe = net.createServer();
        probe.once("error", () => resolvePort(false));
        probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort(true)));
    });

// The side-effecting operations reconcile drives, injectable so the reconcile logic unit-tests without Mutagen.
export interface ForwardExecutor {
    readonly terminate: (port: number) => void;
    readonly create: (summary: PortSummary) => void;
    readonly isLocalPortFree: (port: number) => Promise<boolean>;
}

// The real executor: Mutagen forward sessions named per sandbox+port (so reconcile targets them without listing).
export const mutagenExecutor = (mutagen: string, config: SyncConfig): ForwardExecutor => ({
    terminate: (port) => void spawnSync(mutagen, ["forward", "terminate", forwardSessionName(config.sandboxId, port)], { stdio: "ignore" }),
    create: (summary) =>
        runMutagen(
            mutagen,
            mutagenForwardArgs({
                name: forwardSessionName(config.sandboxId, summary.port),
                port: summary.port,
                alias: sshAlias(config.sandboxId),
                host: summary.host,
            }),
        ),
    isLocalPortFree: localPortFree,
});

// Minimal-touch reconcile: given what's mirrored now (`current`) and what should be (`desired`), leave unchanged
// forwards ALONE (a poll must not drop live connections every tick), terminate ones whose port vanished, and
// (re)create new ports or ones whose sandbox loopback family moved (127.0.0.1 ↔ ::1). Returns the new baseline.
export const reconcileForwards = async (
    executor: ForwardExecutor,
    current: readonly MirroredPort[],
    desired: readonly PortSummary[],
    log: Log,
): Promise<MirroredPort[]> => {
    const desiredByPort = new Map(desired.map((port) => [port.port, port]));
    for (const mirrored of current) {
        const match = desiredByPort.get(mirrored.port);
        if (match === undefined) {
            executor.terminate(mirrored.port);
            log(`  localhost:${mirrored.port} — stopped (no longer listening in the sandbox)`);
        } else if (match.host !== mirrored.host) {
            executor.terminate(mirrored.port); // family moved — the fresh session below dials the new address
        }
    }
    const currentByPort = new Map(current.map((mirrored) => [mirrored.port, mirrored]));
    const next: MirroredPort[] = [];
    for (const summary of desired) {
        const existing = currentByPort.get(summary.port);
        if (existing !== undefined && existing.host === summary.host) {
            next.push(existing); // unchanged — the live forward keeps its connections
            continue;
        }
        if (existing === undefined) {
            // A genuinely new port: clear any leftover session from a crashed run before the free-check.
            executor.terminate(summary.port);
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of ports; sequenced keeps the log readable
        if (!(await executor.isLocalPortFree(summary.port))) {
            log(`  localhost:${summary.port} is busy on this machine — skipped (${summary.command ?? "unknown process"})`);
            continue;
        }
        executor.create(summary);
        next.push({ port: summary.port, host: summary.host });
        log(`  localhost:${summary.port} ← ${summary.command ?? "unknown process"}`);
    }
    return next;
};

const mirrorKey = (mirrored: MirroredPort): string => `${mirrored.port}:${mirrored.host}`;

const sameMirrorSet = (a: readonly MirroredPort[], b: readonly MirroredPort[]): boolean => {
    if (a.length !== b.length) {
        return false;
    }
    const seen = new Set(a.map(mirrorKey));
    return b.every((mirrored) => seen.has(mirrorKey(mirrored)));
};

// The pidfile is how `mirror`/`--stop`/`uninstall` find the resident watcher across processes. A stale pidfile
// (the watcher crashed) reads as "not running": `process.kill(pid, 0)` throws ESRCH for a dead pid; EPERM means
// the pid exists but belongs to another user, which still counts as alive.
export const readLiveWatcherPid = async (): Promise<number | undefined> => {
    const pid = Number((await readFile(mirrorPidPath, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
    }
    try {
        process.kill(pid, 0);
        return pid;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM" ? pid : undefined;
    }
};

// On SIGTERM/SIGINT the watcher drops its pidfile and exits, leaving the forwards up (Mutagen's daemon holds
// them) so a restart never breaks live connections.
const watcherShutdown = (): void => void rm(mirrorPidPath, { force: true }).finally(() => process.exit(0));

// The watcher loop — one resident process per machine (sync is single-holder, so one is always enough). Started
// detached by `startMirrorWatcher`; also runnable in the foreground (`mirror --watch`) to watch it live.
export const runMirrorWatch = async (log: Log): Promise<void> => {
    await writeFile(mirrorPidPath, String(process.pid), { mode: 0o600 });
    // Stop polling on signal, but leave the forwards up — Mutagen's daemon holds them, so a watcher restart
    // never drops the user's connections. Only `--stop`/`uninstall` tear the forwards down.
    process.on("SIGTERM", watcherShutdown);
    process.on("SIGINT", watcherShutdown);

    const first = await readConfig();
    if (first.syncToken === undefined) {
        log("this pairing predates port mirroring — re-run setup to enable it. Watcher exiting.");
        await rm(mirrorPidPath, { force: true });
        return;
    }
    const mutagen = await ensureMutagen();
    log(`mirror watcher started (pid ${process.pid}); polling ${first.sandboxUrl}/ports every ${POLL_MS / 1000}s`);

    for (;;) {
        try {
            const config = await readConfig();
            const ports = config.syncToken === undefined ? [] : await fetchWorkspacePorts(config.sandboxUrl, config.syncToken);
            const next = await reconcileForwards(mutagenExecutor(mutagen, config), config.mirroredPorts ?? [], ports, log);
            if (!sameMirrorSet(config.mirroredPorts ?? [], next)) {
                await writeConfig({ ...config, mirroredPorts: next });
            }
        } catch (error) {
            // A transient tunnel blip or a token hiccup must not kill the loop — log and try again next tick.
            log(`  reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
        await sleep(POLL_MS);
    }
};

// Start the watcher detached so it outlives the terminal that launched it, its stdout appended to mirror.log.
// Idempotent: a live watcher already covers this machine, so a second start is a no-op (the single-holder
// invariant means one watcher is always enough). `cliPath` is this CLI's own entry — re-exec'd with `--watch`.
export const startMirrorWatcher = async (cliPath: string, log: Log): Promise<void> => {
    const existing = await readLiveWatcherPid();
    if (existing !== undefined) {
        log(`port mirroring is already running (pid ${existing}).`);
        return;
    }
    const logFd = openSync(mirrorLogPath, "a");
    const child = spawn(process.execPath, [cliPath, "mirror", "--watch"], { detached: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    log(`mirroring the sandbox's workspace ports onto localhost (pid ${child.pid}). Details: ${mirrorLogPath}`);
};

// Stop mirroring: kill the watcher, then tear down every forward it left up.
export const stopMirror = async (log: Log): Promise<void> => {
    const pid = await readLiveWatcherPid();
    if (pid !== undefined) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // already gone between the read and the kill — nothing to stop
        }
    }
    await rm(mirrorPidPath, { force: true });
    const config = await readConfig();
    const mirrored = config.mirroredPorts ?? [];
    if (mirrored.length > 0) {
        const executor = mutagenExecutor(await ensureMutagen(), config);
        for (const entry of mirrored) {
            executor.terminate(entry.port);
        }
        await writeConfig({ ...config, mirroredPorts: [] });
    }
    log(mirrored.length === 0 ? "port mirroring stopped." : `port mirroring stopped; tore down ${mirrored.length} forward(s).`);
};
