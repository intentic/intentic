import { join } from "node:path";
import { access, readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { killGroup } from "../../workload/process-group.js";
import { detachedStamp } from "../../seams/workload-stamp.js";
import { spawnAs } from "../../workload/workload-class.js";
import { createHash, randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { anySignal, createBackoff, Delayer, Latest, pollUntil } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { freePort } from "@intentic/base/fs";
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api/protocol";
import { backendToolPathsOf } from "@intentic/extension-manifest";
import type { Logger } from "pino";
import { tokenEquals } from "../../auth/auth.js";
import { invalidateContributions } from "../../capabilities/contributions.js";
import type { ExtensionGrant } from "../../auth/grants.js";
import { extensionRuntimeAbsent, RUNTIME_ABSENT_DETAIL } from "../extension-readiness.js";
import { enabledExtensions, type ExtensionHost, type InstalledExtension } from "../installed-extensions.js";
import { listenerOwnershipOf } from "../listener/listener-state.js";
import { prepareExtensionDirs } from "../runtime/extension-state.js";
import {
    BACKEND_CONFIG_ENV,
    BACKEND_HOST_HEADER,
    type BackendExtensionStatus,
    type BackendHealth,
    type BackendDeviceConfig,
    type BackendHostExtension,
    type BackendReload,
} from "./backend-host-config.js";

// Daemon-side supervisor for the backend host process; extension code runs there, never in the daemon, since loaded
// code cannot be unloaded.
// Only a change to what the host runs touches it: the set of backends, their code, and what each is handed at
// activation (hostKeyOf). When every extension that change would replace or remove handed back a `deactivate`, the
// running host lets those go and loads them again in place (POST /reload) and every other backend keeps running;
// otherwise the host restarts. Everything else a converge learns (which tokens resolve, which /x paths are MCP endpoints,
// which extension is absent or incompatible) is read at request time and lands without either. A restart leaves /x
// answering 503 and holds the MCP door's requests meanwhile (extension-mcp.ts); the daemon spawns, waits for health,
// forwards logs, and respawns with backoff. A sweep asks every running backend how it is (its own `health`) on a
// timer, so a backend that stopped serving says so on its row.
// One host for every extension, not one each: a node process costs tens of megabytes resident before any extension
// code loads, paid on every sandbox for every extension with a backend, most of which idle.
// Owns the HOST token (proves a request came through the daemon's gate) and the per-extension tokens, one per enabled
// extension, which its backend and its processes both carry and the extension grant verifies (auth/grants.ts).

// One extension's backend row: the host's own /health states, plus two the supervisor alone can know (absent,
// incompatible).
export type BackendStatus = BackendExtensionStatus | { readonly id: string; readonly state: "absent" | "incompatible"; readonly detail: string };

export interface ExtensionBackendState {
    // `stopped`: no backend to run, or stop() was called. `starting`/`running`/`error`: the host's own arc.
    readonly state: "stopped" | "starting" | "running" | "error";
    readonly detail?: string;
    readonly extensions: readonly BackendStatus[];
}

export interface ExtensionBackend {
    // Converges immediately: enumerates enabled backends and respawns the host. Boot calls this once; everything else
    // uses restart().
    start(): Promise<void>;
    // Debounced converge; safe to call in bursts (toggle, install, workspace-extension edit). Restarts the host only when
    // what it would run changed.
    restart(): void;
    stop(): void;
    status(): ExtensionBackendState;
    statusOf(id: string): BackendStatus | undefined;
    // Where the /x proxy forwards while the host is up; undefined means answer 503 with the current state's detail.
    proxyTarget(): { readonly port: number; readonly hostToken: string } | undefined;
    // Whether an /x path lands in an MCP endpoint an extension's backend answers itself (toolServersOf), as of the last
    // converge: only the daemon's MCP door, which checks the turn's lease, may forward there, so /x/* refuses it.
    isToolPath(pathname: string): boolean;
    // Extension grant resolver (auth/grants.ts): maps a minted per-extension token to the extension and its declared
    // daemon reach, as of the last converge or grantFor.
    verifyExtensionToken(presented: string): ExtensionGrant | undefined;
    // The token an extension's process is started with: minted (once per daemon lifetime) and made to resolve now,
    // so a process that dials the daemon before the next converge is not refused. A disabled or removed extension's
    // stops resolving at the converge its toggle or removal triggers.
    grantFor(extension: InstalledExtension): string;
}

// The /x paths an extension's backend answers MCP at itself (`contributes.tools` with a `path`, or a cli card's `mcp`).
const declaredToolPaths = (extension: InstalledExtension): readonly string[] => backendToolPathsOf(extension.manifest);

// An /x path as the backend host routes it: segments decoded and empty ones dropped, so neither `%6Dcp` nor `//mcp`
// reads as a different path here than it does there.
const namespacePath = (pathname: string): { readonly extension: string; readonly rest: string } | undefined => {
    const segments = pathname
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        });
    return segments[0] !== "x" || segments[1] === undefined ? undefined : { extension: segments[1], rest: segments.slice(2).join("/") };
};

// Resolves the host entry beside this file so dev and dist take the same code path (.js under node, .ts under tsx).
// Uses an absolute path so the spawn's cwd cannot change which one runs.
const hostCommand = (): { readonly file: string; readonly args: readonly string[] } => {
    const dev = import.meta.url.endsWith(".ts");
    const entry = fileURLToPath(new URL(dev ? "./backend-host-main.ts" : "./backend-host-main.js", import.meta.url));
    return dev
        ? { file: process.execPath, args: ["--import", createRequire(import.meta.url).resolve("tsx"), entry] }
        : { file: process.execPath, args: [entry] };
};

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 200;
// How often every running backend is asked how it is; the first ask follows the host becoming healthy at once.
const HEALTH_SWEEP_MS = 30_000;
// What a host's key reads once a reload it was sent went unanswered or refused: no set of backends hashes to it, so the
// next converge never takes that host for one already running what it wants.
const UNKNOWN_HOST_KEY = "unknown";
const RESTART_DEBOUNCE_MS = 300;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

interface SpawnedHost {
    readonly child: ChildProcess;
    readonly port: number;
    readonly hostToken: string;
    readonly workspaceRoot: string;
    // What it runs now (hostKeyOf, and the backends behind it): an unchanged key means a converge leaves it running. Moved
    // by an in-place reload, which keeps the same process, so the object stays the one its exit handler compares.
    key: string;
    runnable: readonly BackendHostExtension[];
}

// A server bundle's content digest: the code the host would load. A bundle it cannot read hashes as absent, which a
// later converge that can read it tells apart.
const bundleDigest = async (dir: string, server: string): Promise<string> =>
    readFile(join(dir, server)).then(
        (bytes) => createHash("sha256").update(bytes).digest("hex"),
        () => "unreadable",
    );

// What one backend is handed at activation and the code it runs; tokens are minted once per daemon and so never move it.
const extensionKeyOf = ({ id, dir, server, daemonPermissions, bundle, stateDir, cacheDir }: BackendHostExtension): string =>
    JSON.stringify({ id, dir, server, daemonPermissions: [...daemonPermissions].toSorted(), bundle, stateDir, cacheDir });

// Everything the host process is handed that it cannot re-read at request time: which backends, from where, their code,
// and what each is told at activation.
const hostKeyOf = (workspaceRoot: string, runnable: readonly BackendHostExtension[]): string =>
    JSON.stringify({
        workspaceRoot,
        extensions: runnable.map(extensionKeyOf).toSorted(),
    });

export interface ExtensionBackendOptions {
    // How long a spawned host has to answer /health before it is killed and retried; a test shortens it.
    readonly healthTimeoutMs?: number;
}

export const createExtensionBackend = (
    services: () => ExtensionHost,
    daemonPort: number,
    logger: Logger,
    { healthTimeoutMs = HEALTH_TIMEOUT_MS }: ExtensionBackendOptions = {},
): ExtensionBackend => {
    // Minted once per daemon lifetime so a restart doesn't invalidate an in-flight token; reach resolves separately.
    const tokens = new Map<string, string>();
    const tokenFor = (id: string): string => {
        const existing = tokens.get(id);
        if (existing !== undefined) {
            return existing;
        }
        const minted = randomBytes(32).toString("hex");
        tokens.set(id, minted);
        return minted;
    };
    // Token to the grant it was minted for, as of the last converge: every enabled extension, backend or not.
    let reach = new Map<string, ExtensionGrant>();
    // Extension id to the MCP endpoint paths its cli contributions declare, as of the last converge.
    let toolPaths = new Map<string, readonly string[]>();
    // Listener provider to its owning extension, as of the last converge (listener-state.ts). A declaration another
    // extension owns is left out of the grant; one the last converge has not seen yet (an install racing its converge) is
    // granted, and the listener routes resolve the owner again per request.
    let listenerOwners: ReadonlyMap<string, string> = new Map();
    const grantOf = (extension: InstalledExtension, owners: ReadonlyMap<string, string> = listenerOwners): ExtensionGrant => {
        const provider = extension.manifest.contributes?.listener?.provider;
        const owner = provider === undefined ? undefined : owners.get(provider);
        return {
            id: extension.id,
            permissions: extension.manifest.permissions?.daemon ?? [],
            ...(provider === undefined || (owner !== undefined && owner !== extension.id) ? {} : { listener: provider }),
        };
    };
    // A refused listener declaration is said once per extension per daemon, at load; the Extensions list says it too.
    const warnedListener = new Set<string>();

    // A plugin's `.mcp.json` is deprecated for `contributes.tools`; said once per extension per daemon, at load.
    const warnedPluginMcp = new Set<string>();
    const warnPluginMcp = async (extension: InstalledExtension): Promise<void> => {
        const agent = extension.manifest.contributes?.agent;
        if (agent === undefined || warnedPluginMcp.has(extension.id)) {
            return;
        }
        const declared = join(agent.path === undefined ? extension.dir : join(extension.dir, agent.path), ".mcp.json");
        if (await access(declared).then(() => true, () => false)) {
            warnedPluginMcp.add(extension.id);
            logger.warn(
                { extension: extension.id, file: declared },
                "extension ships MCP servers in its agent plugin's .mcp.json, which only Claude Code turns read and is deprecated: declare contributes.tools instead",
            );
        }
    };

    let desired = false;
    let host: SpawnedHost | undefined;
    let state: ExtensionBackendState = { state: "stopped", extensions: [] };
    // Climbs while the host keeps dying on arrival; resets the moment one answers /health.
    const ladder = createBackoff({ floorMs: BACKOFF_START_MS, capMs: BACKOFF_CAP_MS });
    // The converge in flight. A newer one, or stop(), aborts it: it then spawns no host that nothing would own, and stops
    // polling /health for one it no longer wants, rather than carrying on to be ignored.
    const converging = new Latest();
    const debounce = new Delayer<void>(RESTART_DEBOUNCE_MS);
    // The wait before trying again after a host died or never answered. A timer and not a Delayer, since its length is
    // the ladder's; one slot, cleared before it is set, so a second schedule replaces the first instead of leaving it to
    // fire after stop() cleared only the second.
    let retry: NodeJS.Timeout | undefined;
    const retryLater = (): void => {
        clearTimeout(retry);
        retry = setTimeout(() => void converge(), ladder.next());
    };

    // The host's whole process group, SIGKILL after a grace, as the service supervisor ends its children: a SIGTERM to
    // the host alone left anything a backend started running, and a host wedged in an extension's code kept its port
    // and memory beside the one respawned in its place.
    const kill = (): void => {
        if (host !== undefined) {
            killGroup(host.child);
            host = undefined;
        }
    };

    // A backend's reach is enforced on the daemon side, by its token; the host is handed the same list only to refuse a
    // typed call before sending it.
    const collect = async (): Promise<{
        runnable: BackendHostExtension[];
        reported: BackendStatus[];
        tokenReach: Map<string, ExtensionGrant>;
        tools: Map<string, readonly string[]>;
        owners: ReadonlyMap<string, string>;
    }> => {
        const runnable: BackendHostExtension[] = [];
        const reported: BackendStatus[] = [];
        const tokenReach = new Map<string, ExtensionGrant>();
        const tools = new Map<string, readonly string[]>();
        const enabled = await enabledExtensions(services());
        const ownership = await listenerOwnershipOf(services(), enabled);
        for (const [id, problem] of ownership.refused) {
            if (!warnedListener.has(id)) {
                warnedListener.add(id);
                logger.warn({ extension: id }, problem);
            }
        }
        for (const extension of enabled) {
            // Every enabled extension resolves, not just a backend's: its processes carry the same token.
            const grant = grantOf(extension, ownership.owners);
            await warnPluginMcp(extension);
            tokenReach.set(tokenFor(extension.id), grant);
            const server = extension.manifest.server;
            if (server === undefined) {
                continue;
            }
            tools.set(extension.id, declaredToolPaths(extension));
            if (!satisfiesEngines(extension.manifest.engines.intentic, extensionApiVersion)) {
                reported.push({
                    id: extension.id,
                    state: "incompatible",
                    detail: `needs intentic ${extension.manifest.engines.intentic}; this daemon provides ${extensionApiVersion}`,
                });
                continue;
            }
            // A core image can bake the manifest without its tree; not loading is the only honest answer here too.
            if (await extensionRuntimeAbsent(extension)) {
                reported.push({ id: extension.id, state: "absent", detail: RUNTIME_ABSENT_DETAIL });
                continue;
            }
            // Its own directories exist before its code runs, made here rather than by the host, which reads no daemon state.
            const dirs = await prepareExtensionDirs(services().workspace.root, extension.manifest);
            runnable.push({
                id: extension.id,
                dir: extension.dir,
                server,
                daemonToken: tokenFor(extension.id),
                daemonPermissions: grant.permissions,
                bundle: await bundleDigest(extension.dir, server),
                stateDir: dirs.stateDir,
                cacheDir: dirs.cacheDir,
            });
        }
        return { runnable, reported, tokenReach, tools, owners: ownership.owners };
    };

    // The host's /health answer, or undefined if it died first, never answered in time, or the converge waiting on it was
    // aborted; the caller treats every miss alike.
    const waitHealthy = async (spawned: SpawnedHost, signal: AbortSignal): Promise<BackendHealth | undefined> => {
        let health: BackendHealth | undefined;
        await pollUntil(
            async () => {
                // A signal death leaves exitCode null; either way there is nothing left to wait for.
                if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
                    return true;
                }
                try {
                    const response = await fetch(`http://127.0.0.1:${spawned.port}/health`, {
                        headers: { [BACKEND_HOST_HEADER]: spawned.hostToken },
                        // The converge's signal too, so a stop cuts a probe already in flight instead of waiting it out.
                        signal: anySignal(signal, AbortSignal.timeout(HEALTH_POLL_MS * 4)),
                    });
                    if (response.ok) {
                        health = (await response.json()) as BackendHealth;
                        return true;
                    }
                } catch {
                    // Not up yet; the poll is the wait.
                }
                return false;
            },
            { intervalMs: HEALTH_POLL_MS, timeoutMs: healthTimeoutMs, signal },
        );
        return health;
    };

    // The host's own rows from its last /health, kept so a converge that leaves it running can still report them.
    let hostStatuses: readonly BackendExtensionStatus[] = [];
    // The rows only the supervisor knows (absent, incompatible), as of the last converge, for a sweep to report beside.
    let lastReported: readonly BackendStatus[] = [];

    // Whether the running host can take `next` in place: the same workspace, and every backend it runs that would change
    // or go handed back a `deactivate` (its status says `reloadable`). A backend arriving needs nothing of the host.
    const reloadableTo = (spawned: SpawnedHost, workspaceRoot: string, next: readonly BackendHostExtension[]): boolean => {
        if (spawned.workspaceRoot !== workspaceRoot) {
            return false;
        }
        const wanted = new Map(next.map((extension) => [extension.id, extensionKeyOf(extension)]));
        return spawned.runnable.every(
            (extension) =>
                wanted.get(extension.id) === extensionKeyOf(extension) || hostStatuses.find((status) => status.id === extension.id)?.reloadable === true,
        );
    };

    // The host's answer to an in-place reload, or undefined for a refusal or no answer, which the caller meets with a
    // restart.
    const reloadInPlace = async (spawned: SpawnedHost, next: readonly BackendHostExtension[]): Promise<readonly BackendExtensionStatus[] | undefined> => {
        try {
            const response = await fetch(`http://127.0.0.1:${spawned.port}/reload`, {
                method: "POST",
                headers: { [BACKEND_HOST_HEADER]: spawned.hostToken, "content-type": "application/json" },
                body: JSON.stringify({ extensions: next } satisfies BackendReload),
                signal: AbortSignal.timeout(healthTimeoutMs),
            });
            if (!response.ok) {
                logger.info({ status: response.status, detail: await response.text() }, "extension backends could not reload in place: restarting the host");
                return undefined;
            }
            // SAFETY: the host is this build's own child (backend-host.ts), which answers a reload with its BackendHealth.
            return ((await response.json()) as BackendHealth).extensions;
        } catch (error) {
            logger.warn({ err: error }, "extension backend host did not answer its reload: restarting it");
            return undefined;
        }
    };

    // Asks the running host how every backend is (`?deep` runs each one's own health check) and folds the answer into the
    // rows. A sweep that finds the host gone or replaced says nothing: the exit handler or the next converge does.
    const sweepHealth = async (): Promise<void> => {
        const spawned = host;
        if (spawned === undefined || state.state !== "running") {
            return;
        }
        const at = converging.current;
        try {
            const response = await fetch(`http://127.0.0.1:${spawned.port}/health?deep=1`, {
                headers: { [BACKEND_HOST_HEADER]: spawned.hostToken },
                signal: AbortSignal.timeout(healthTimeoutMs),
            });
            if (!response.ok) {
                return;
            }
            // SAFETY: the host is this build's own child (backend-host.ts), which answers /health with its BackendHealth.
            const health = (await response.json()) as BackendHealth;
            if (host !== spawned || at !== converging.current || state.state !== "running") {
                return;
            }
            hostStatuses = health.extensions;
            state = { state: "running", extensions: [...health.extensions, ...lastReported] };
        } catch (error) {
            logger.info({ err: error }, "extension backend health sweep got no answer; the exit handler or the next sweep says more");
        }
    };
    let sweep: NodeJS.Timeout | undefined;
    // The in-place reload in flight, if any, settling once what the host runs is recorded.
    let reloadLanding: Promise<unknown> | undefined;

    // The in-place half of a converge: `done` when the running host took the new set, `superseded` when a later converge
    // started meanwhile, `restart` when it could not or would not, which the caller answers by replacing the host.
    const replaceInPlace = async (
        signal: AbortSignal,
        key: string,
        workspaceRoot: string,
        collected: { readonly runnable: readonly BackendHostExtension[]; readonly reported: readonly BackendStatus[] },
    ): Promise<"done" | "superseded" | "restart"> => {
        const spawned = host;
        if (spawned === undefined || state.state !== "running" || collected.runnable.length === 0 || !reloadableTo(spawned, workspaceRoot, collected.runnable)) {
            return "restart";
        }
        // What the host runs is recorded as the reload lands, whether or not this converge is still wanted by then: the
        // host applies a reload it was sent either way, and the converge that superseded this one waits for this landing
        // before it compares against the host.
        const landing = (async (): Promise<readonly BackendExtensionStatus[] | undefined> => {
            const statuses = await reloadInPlace(spawned, collected.runnable);
            if (host === spawned) {
                if (statuses === undefined) {
                    // Refused or unanswered, the host runs something nobody can name: no converge may read it as
                    // already running what it wants.
                    spawned.key = UNKNOWN_HOST_KEY;
                } else {
                    spawned.key = key;
                    spawned.runnable = collected.runnable;
                    hostStatuses = statuses;
                }
            }
            return statuses;
        })();
        reloadLanding = landing;
        const statuses = await landing.finally(() => {
            if (reloadLanding === landing) {
                reloadLanding = undefined;
            }
        });
        if (signal.aborted) {
            return "superseded";
        }
        if (statuses === undefined || host !== spawned) {
            return "restart";
        }
        state = { state: "running", extensions: [...statuses, ...collected.reported] };
        void sweepHealth();
        return "done";
    };

    const converge = async (): Promise<void> => {
        const signal = converging.next();
        clearTimeout(retry);
        let collected: Awaited<ReturnType<typeof collect>>;
        try {
            collected = await collect();
        } catch (error) {
            // Nothing learnt, so nothing to change: a host already running keeps running on what it was given. Nor does
            // a converge already superseded or stopped report it, over whatever state came after it.
            if (host === undefined && !signal.aborted) {
                state = { state: "error", detail: errorMessage(error), extensions: [] };
            }
            return;
        }
        // A reload a superseded converge already sent lands on the host whatever happens to that converge: waited for,
        // so the host is compared as it will be rather than as it was.
        const pending = reloadLanding;
        if (pending !== undefined && !signal.aborted) {
            await pending;
        }
        if (signal.aborted) {
            return;
        }
        // Read at request time, so these land whether or not the host restarts.
        reach = collected.tokenReach;
        toolPaths = collected.tools;
        listenerOwners = collected.owners;
        lastReported = collected.reported;
        const workspaceRoot = services().workspace.root;
        const key = hostKeyOf(workspaceRoot, collected.runnable);
        // The same backends, the same code, the same activation: the running host is already what this converge wants.
        if (host !== undefined && host.key === key && state.state === "running") {
            state = { state: "running", extensions: [...hostStatuses, ...collected.reported] };
            return;
        }
        // Only backends that can be let go of change: the running host replaces them and keeps the rest running.
        const inPlace = await replaceInPlace(signal, key, workspaceRoot, collected);
        if (inPlace !== "restart") {
            return;
        }
        kill();
        if (collected.runnable.length === 0) {
            hostStatuses = [];
            state = { state: "stopped", extensions: collected.reported };
            return;
        }
        state = { state: "starting", extensions: collected.reported };
        const port = await freePort();
        // Asked again after the last wait before the spawn: a host started for a converge stopped or superseded meanwhile
        // would belong to nobody, left running after stop() or beside the next converge's own.
        if (signal.aborted) {
            return;
        }
        const hostToken = randomBytes(32).toString("hex");
        const config: BackendDeviceConfig = {
            port,
            hostToken,
            daemonUrl: `http://127.0.0.1:${daemonPort}`,
            workspaceRoot,
            apiVersion: extensionApiVersion,
            extensions: collected.runnable,
        };
        const command = hostCommand();
        const child = spawnAs({ class: "service" }, command.file, command.args, {
            // Stamped, since its own group is out of reach of netd's group kill: the boot sweep ends one an
            // earlier daemon run left behind.
            env: { ...process.env, ...detachedStamp("backend-host"), [BACKEND_CONFIG_ENV]: JSON.stringify(config) },
            // A process group of its own, killable as a unit with whatever its backends started.
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
        });
        const spawned: SpawnedHost = { child, port, hostToken, workspaceRoot, key, runnable: collected.runnable };
        host = spawned;
        // Both streams feed the daemon log; extension lines carry their own [id] prefix already.
        for (const stream of [child.stdout, child.stderr]) {
            if (stream !== null) {
                createInterface({ input: stream }).on("line", (line) => logger.info(`extension-backend: ${line}`));
            }
        }
        // Judged by which host this is, not by the converge that started it: a later converge that left it running
        // still wants its death noticed.
        child.on("error", (error) => {
            if (host === spawned) {
                state = { state: "error", detail: error.message, extensions: collected.reported };
            }
        });
        child.on("exit", (code, exitSignal) => {
            if (host !== spawned || !desired) {
                return;
            }
            // Uninvited death: report it and respawn with backoff rather than leave /x dead forever.
            state = { state: "error", detail: `the backend host exited (${exitSignal ?? code})`, extensions: collected.reported };
            host = undefined;
            retryLater();
        });
        const health = await waitHealthy(spawned, signal);
        if (signal.aborted) {
            return;
        }
        if (health === undefined) {
            // A host that died on arrival was already reported and rescheduled by its exit handler, which said how it
            // ended; that sentence stands.
            if (host !== spawned) {
                return;
            }
            // Alive but silent, most likely an activation that never returns: every backend waits behind it, so it is
            // killed and tried again on the same ladder as a death, rather than left holding /x at 503 until something
            // else restarts it.
            logger.warn({ timeoutMs: healthTimeoutMs }, "extension backend host did not answer /health in time: killing it and retrying");
            kill();
            state = {
                state: "error",
                detail: `the backend host did not become healthy within ${healthTimeoutMs / 1_000}s`,
                extensions: collected.reported,
            };
            retryLater();
            return;
        }
        ladder.reset();
        hostStatuses = health.extensions;
        state = { state: "running", extensions: [...health.extensions, ...collected.reported] };
        void sweepHealth();
    };

    return {
        start: async () => {
            desired = true;
            clearInterval(sweep);
            sweep = setInterval(() => void sweepHealth(), HEALTH_SWEEP_MS);
            sweep.unref();
            await converge();
        },
        restart: () => {
            // Every caller is saying the extension set may have moved (an install, a toggle, a removal, an approval, a
            // write under an extension's folder), which is what the contribution inventory is built from. Whether the
            // host itself restarts is the converge's to decide, by what it would run.
            invalidateContributions();
            if (!desired) {
                return;
            }
            void debounce.trigger(converge);
        },
        stop: () => {
            desired = false;
            converging.abort();
            debounce.cancel();
            clearTimeout(retry);
            clearInterval(sweep);
            kill();
            state = { state: "stopped", extensions: [] };
        },
        status: () => state,
        statusOf: (id) => state.extensions.find((extension) => extension.id === id),
        proxyTarget: () => (host !== undefined && state.state === "running" ? { port: host.port, hostToken: host.hostToken } : undefined),
        isToolPath: (pathname) => {
            const at = namespacePath(pathname);
            return at !== undefined && (toolPaths.get(at.extension) ?? []).some((path) => at.rest === path || at.rest.startsWith(`${path}/`));
        },
        verifyExtensionToken: (presented) => {
            for (const [token, grant] of reach) {
                if (tokenEquals(presented, token)) {
                    return grant;
                }
            }
            return undefined;
        },
        grantFor: (extension) => {
            const token = tokenFor(extension.id);
            reach = new Map(reach).set(token, grantOf(extension));
            return token;
        },
    };
};
