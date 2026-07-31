import { spawn, spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { type PortSummary, PortsListSchema } from "@intentic/sandbox-contract";
import { unregisterAutostart } from "./autostart.js";
import { type Log, type MirroredPort, mirrorLogPath, mirrorPidPath, readConfig, type SyncConfig, writeConfig } from "./config.js";
import { realBridgeExec, runGitBridge } from "./git-bridge.js";
import { ensureMutagen, ensureSyncSession, forwardSessionName, mutagenForwardArgs, ourForwardSessions, runMutagen } from "./mutagen.js";
import { sshAlias } from "./ssh.js";

// Port mirroring: every WORKSPACE port listening in the sandbox is bound to the SAME port on this machine's
// localhost, over Mutagen TCP forward sessions riding the enrolled SSH transport. This is what makes remote
// development feel local — a frontend baked with `https://localhost:6480` just works (cookies + CORS included)
// because localhost IS serving it. A resident watcher polls the daemon's /ports so a dev server started later
// (Vite grabbing a fresh random port) is mirrored within a poll, with no user action.

// How to re-invoke this CLI: the executable followed by any leading args the command must come after. Non-empty
// by construction — see cliLauncher in commands.ts, which is the only thing that builds one.
export type CliLauncher = readonly [string, ...string[]];

// How often the watcher re-reads the sandbox's ports. Fast enough that a just-started dev server is reachable
// before the user finishes alt-tabbing to the browser; slow enough to be free.
const POLL_MS = 5000;

// How long to wait on the ports read before abandoning it. Undici's defaults let a hung tunnel — as opposed to
// a tunnel that fails fast — sit on this await for minutes, and the loop is sequential, so everything after it
// waits exactly that long, the git bridge included. A tiny JSON over an ssh-grade link either answers well
// inside this or isn't coming.
const PORTS_TIMEOUT_MS = 10_000;

// The git bridge (git-bridge.ts) runs on EVERY tick: no .git file-syncs anymore, so it is the only way the
// sandbox's commits reach the local clones, and file sync delivers a commit's FILES within seconds. Every
// second the bridge lags is therefore a second `git status` here reports the whole landed change as
// uncommitted. A quiet pass now costs one `ls-remote` per repo, cheap enough that the once-a-minute cadence
// this replaces was buying nothing but that lag.
//
// The sandbox's repo SET, though, changes only when a repo is added or removed — so it is cached between passes
// and re-listed only this often, sparing a round trip on every tick in between.
const REPO_LIST_EVERY_TICKS = 12;

// How long to wait for a signalled watcher to actually exit, and how often to look. A watcher spends its life
// asleep between polls, so it answers a signal in milliseconds; this bound only covers one wedged in a fetch.
const WATCHER_EXIT_TIMEOUT_MS = 2000;
const WATCHER_EXIT_POLL_MS = 50;

// Consecutive definitive token rejections before the watcher treats the enrollment as revoked ("Disable sync"
// in the browser, or a recreated sandbox that lost the enrollment) and tears itself down. Revocation never
// heals on its own, so three polls (~15s) is already generous slack against a freak one-off.
const REVOKED_POLLS = 3;

// The daemon's definitive "this token is not enrolled" answer (401/403) — distinct from transient failures so
// the watcher can tell revocation (self-teardown) from a tunnel blip (retry next tick).
export class SyncAuthError extends Error {}

// The sandbox's currently-listening WORKSPACE ports (dev servers, terminal processes, published containers) —
// what the reconcile drives from. Authenticated by the enrollment-minted sync token, which the daemon scopes
// to exactly this read. System ports (the sandbox's own machinery) are filtered out and never mirrored, and so
// are non-forwardable binds (a loopback alias Mutagen would dial at 127.0.0.1 and never reach).
export const fetchWorkspacePorts = async (sandboxUrl: string, syncToken: string): Promise<PortSummary[]> => {
    const response = await fetch(`${sandboxUrl.replace(/\/$/, "")}/ports`, {
        headers: { "x-intentic-sync": syncToken },
        signal: AbortSignal.timeout(PORTS_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
        throw new SyncAuthError(
            "the sandbox rejected the sync token — click “Enable desktop sync” in your browser and re-run setup to mint a fresh one.",
        );
    }
    if (!response.ok) {
        throw new Error(`reading the sandbox's ports failed (${response.status}): ${await response.text()}`);
    }
    return PortsListSchema.parse(await response.json()).ports.filter((port) => port.kind === "workspace" && port.forwardable);
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

// Whether a pid is a live process: `process.kill(pid, 0)` throws ESRCH for a dead one, while EPERM means it
// exists but belongs to another user — which still counts as alive.
const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
};

// The pidfile is how `mirror`/`--stop`/`uninstall`/`setup` find the resident watcher across processes. A stale
// pidfile (the watcher crashed) reads as "not running".
export const readLiveWatcherPid = async (): Promise<number | undefined> => {
    const pid = Number((await readFile(mirrorPidPath, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
        return undefined;
    }
    return alive(pid) ? pid : undefined;
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
    // The watcher runs at every login, which makes it the one place an upgraded agent reliably reaches the file
    // sync it INHERITED — Mutagen bakes a session's ignores at creation, so an install that swapped the binary
    // without re-pairing would otherwise keep syncing on whatever rules were current the day it first paired.
    ensureSyncSession(mutagen, first, log);
    log(`mirror watcher started (pid ${process.pid}); polling ${first.sandboxUrl}/ports every ${POLL_MS / 1000}s`);

    let rejectedPolls = 0;
    let repos: readonly string[] | undefined;
    for (let tick = 0; ; tick += 1) {
        // Read once and share it: the two halves below each get their own catch, but a config that won't parse
        // (a concurrent `setup` rewriting it) leaves neither of them anything to do.
        const config = await readConfig().catch((error: unknown) => {
            log(`  tick skipped: the sync config didn't read (${error instanceof Error ? error.message : String(error)})`);
            return undefined;
        });
        if (config !== undefined) {
            try {
                const ports = config.syncToken === undefined ? [] : await fetchWorkspacePorts(config.sandboxUrl, config.syncToken);
                rejectedPolls = 0;
                const next = await reconcileForwards(mutagenExecutor(mutagen, config), config.mirroredPorts ?? [], ports, log);
                if (!sameMirrorSet(config.mirroredPorts ?? [], next)) {
                    await writeConfig({ ...config, mirroredPorts: next });
                }
            } catch (error) {
                // Revocation is definitive: after REVOKED_POLLS consecutive rejections, stop for good — drop the
                // login autostart, tear down the forwards, and exit — instead of polling a dead enrollment forever
                // (and resurrecting at every login).
                if (error instanceof SyncAuthError && ++rejectedPolls >= REVOKED_POLLS) {
                    log(`the sandbox rejected the sync token ${REVOKED_POLLS} polls in a row — this machine's enrollment was revoked.`);
                    await unregisterAutostart(log);
                    log(stopped(await teardownForwards(mutagen)));
                    await rm(mirrorPidPath, { force: true });
                    log("re-enable from the Desktop sync card, or run `intentic-sync uninstall` to remove the agent entirely.");
                    return;
                }
                // A transient tunnel blip must not kill the loop — log and try again next tick.
                log(`  reconcile skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
            // The bridge gets its OWN catch. It rides ssh; the ports read above rides https, through Cloudflare,
            // which 502s the sandbox's /ports often enough to matter while the tunnel underneath is perfectly
            // healthy. Sharing one catch meant every such 502 silently cost a whole bridge pass — and because
            // the cadence counted ticks rather than retrying, the next attempt came a full period later, not a
            // tick later, which is what turned a sub-minute lag into the occasional two-minute one.
            try {
                repos = runGitBridge(realBridgeExec, config, log, tick % REPO_LIST_EVERY_TICKS === 0 ? undefined : repos);
            } catch (error) {
                log(`  git bridge skipped: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        await sleep(POLL_MS);
    }
};

// Start the watcher detached so it outlives the terminal that launched it, its stdout appended to mirror.log.
// Idempotent: a live watcher already covers this machine, so a second start is a no-op (the single-holder
// invariant means one watcher is always enough). `launcher` is how to re-invoke this CLI (see cliLauncher).
// windowsHide keeps a detached child from getting a console window of its own — this is what the login
// autostart runs (autostart.ts registers `mirror`, which lands here), and the watcher never exits, so without
// it every Windows login would leave a black console parked on the desktop until shutdown.
export const startMirrorWatcher = async (launcher: CliLauncher, log: Log): Promise<void> => {
    const existing = await readLiveWatcherPid();
    if (existing !== undefined) {
        log(`port mirroring is already running (pid ${existing}).`);
        return;
    }
    const logFd = openSync(mirrorLogPath, "a");
    const [command, ...leading] = launcher;
    const child = spawn(command, [...leading, "mirror", "--watch"], { detached: true, windowsHide: true, stdio: ["ignore", logFd, logFd] });
    child.unref();
    log(`mirroring the sandbox's workspace ports onto localhost (pid ${child.pid}). Details: ${mirrorLogPath}`);
};

// Tear down every forward session this agent owns — read from the DAEMON, not from the config's baseline. A
// setup that pairs a new sandbox writes a config with no baseline at all, so everything the previous pairing
// left running was nameable by nobody and terminated by no one, while Mutagen kept its localhost listener
// bound for good (verified against 0.18.1: a session whose sandbox has been destroyed still reports
// ForwardingConnections and still holds the port). Every port the old sandbox used then read as "busy on this
// machine" to the next pairing and silently stopped mirroring, for as long as the machine stayed up.
const teardownForwards = async (mutagen: string): Promise<number> => {
    const names = ourForwardSessions(mutagen);
    if (names.length > 0) {
        spawnSync(mutagen, ["forward", "terminate", ...names], { stdio: "ignore" });
    }
    // A baseline naming forwards that no longer exist would make the next reconcile treat those ports as
    // already mirrored and never recreate them. No config yet (a first-ever setup) means no baseline to clear.
    const config = await readConfig().catch(() => undefined);
    if (config !== undefined && (config.mirroredPorts ?? []).length > 0) {
        await writeConfig({ ...config, mirroredPorts: [] });
    }
    return names.length;
};

const stopped = (forwards: number): string =>
    forwards === 0 ? "port mirroring stopped." : `port mirroring stopped; tore down ${forwards} forward(s).`;

// What retiring found to retire, so the caller can phrase it: a deliberate `--stop` reports that it stopped,
// while a setup reports what the PREVIOUS pairing had left behind.
export interface RetiredMirror {
    readonly pid?: number;
    readonly forwards: number;
}

// Retire this machine's port mirroring completely: stop the resident watcher, then tear down its forwards.
// Waits for the watcher to be gone rather than merely signalled — it re-reads the config every tick and writes
// the mirror baseline back into it, so a caller that replaces the config while it is still alive can have the
// OLD pairing written back over the new one; on Windows it also holds the agent binary open. Bounded, because
// a watcher that won't die is not a reason to fail the command that asked for this.
export const retireMirror = async (mutagen: string): Promise<RetiredMirror> => {
    const pid = await readLiveWatcherPid();
    if (pid !== undefined) {
        try {
            process.kill(pid, "SIGTERM");
        } catch {
            // already gone between the read and the kill — nothing to stop
        }
        for (let waited = 0; waited < WATCHER_EXIT_TIMEOUT_MS && alive(pid); waited += WATCHER_EXIT_POLL_MS) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- a bounded wait for one pid, by definition serial
            await sleep(WATCHER_EXIT_POLL_MS);
        }
    }
    await rm(mirrorPidPath, { force: true });
    return { ...(pid === undefined ? {} : { pid }), forwards: await teardownForwards(mutagen) };
};

// Stop mirroring on purpose (`mirror --stop`, `uninstall`) and say what went.
export const stopMirror = async (log: Log): Promise<void> => {
    log(stopped((await retireMirror(await ensureMutagen())).forwards));
};
