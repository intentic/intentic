import type { ChildProcess } from "node:child_process";
import { spawnAs } from "../../workload/workload-class.js";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createBackoff, pollUntil } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api/protocol";
import type { Logger } from "pino";
import { tokenEquals } from "../../auth/auth.js";
import type { ExtensionGrant } from "../../auth/grants.js";
import { extensionRuntimeAbsent, RUNTIME_ABSENT_DETAIL } from "../extension-readiness.js";
import { enabledExtensions, type ExtensionHost, type InstalledExtension } from "../installed-extensions.js";
import { freePort } from "../../processes/free-port.js";
import {
    BACKEND_CONFIG_ENV,
    BACKEND_HOST_HEADER,
    type BackendExtensionStatus,
    type BackendHealth,
    type BackendDeviceConfig,
    type BackendHostExtension,
} from "./backend-host-config.js";

// Daemon-side supervisor for the backend host process; extension code runs there, never in the daemon, since loaded
// code cannot be unloaded.
// Every lifecycle change is a host restart (/x routes answer 503 meanwhile); the daemon spawns, waits for health,
// forwards logs, and respawns with backoff.
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
    // Debounced converge; safe to call in bursts (toggle, install, workspace-extension edit).
    restart(): void;
    stop(): void;
    status(): ExtensionBackendState;
    statusOf(id: string): BackendStatus | undefined;
    // Where the /x proxy forwards while the host is up; undefined means answer 503 with the current state's detail.
    proxyTarget(): { readonly port: number; readonly hostToken: string } | undefined;
    // Whether an /x path lands in an extension's declared MCP endpoint (a cli contribution's `mcp`), as of the last
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

// The MCP endpoint paths an extension's cli contributions declare, relative to its /x/<id> namespace.
const declaredToolPaths = (extension: InstalledExtension): readonly string[] =>
    (extension.manifest.contributes?.capabilities ?? []).flatMap((spec) => (spec.kind === "cli" && spec.mcp !== undefined ? [spec.mcp] : []));

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
const RESTART_DEBOUNCE_MS = 300;
const BACKOFF_START_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;

interface SpawnedHost {
    readonly child: ChildProcess;
    readonly port: number;
    readonly hostToken: string;
}

export const createExtensionBackend = (services: () => ExtensionHost, daemonPort: number, logger: Logger): ExtensionBackend => {
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
    const grantOf = (extension: InstalledExtension): ExtensionGrant => ({
        id: extension.id,
        permissions: extension.manifest.permissions?.daemon ?? [],
        ...(extension.manifest.contributes?.listener === undefined ? {} : { listener: extension.manifest.contributes.listener.provider }),
    });

    let generation = 0;
    let desired = false;
    let host: SpawnedHost | undefined;
    let state: ExtensionBackendState = { state: "stopped", extensions: [] };
    // Climbs while the host keeps dying on arrival; resets the moment one answers /health.
    const ladder = createBackoff({ floorMs: BACKOFF_START_MS, capMs: BACKOFF_CAP_MS });
    let debounce: NodeJS.Timeout | undefined;
    let retry: NodeJS.Timeout | undefined;

    const kill = (): void => {
        if (host !== undefined) {
            host.child.kill();
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
    }> => {
        const runnable: BackendHostExtension[] = [];
        const reported: BackendStatus[] = [];
        const tokenReach = new Map<string, ExtensionGrant>();
        const tools = new Map<string, readonly string[]>();
        for (const extension of await enabledExtensions(services())) {
            // Every enabled extension resolves, not just a backend's: its processes carry the same token.
            const grant = grantOf(extension);
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
            runnable.push({ id: extension.id, dir: extension.dir, server, daemonToken: tokenFor(extension.id), daemonPermissions: grant.permissions });
        }
        return { runnable, reported, tokenReach, tools };
    };

    // The host's /health answer, or undefined if it died first or never answered in time; the caller treats both misses
    // alike.
    const waitHealthy = async (spawned: SpawnedHost): Promise<BackendHealth | undefined> => {
        let health: BackendHealth | undefined;
        await pollUntil(
            async () => {
                if (spawned.child.exitCode !== null) {
                    return true;
                }
                try {
                    const response = await fetch(`http://127.0.0.1:${spawned.port}/health`, {
                        headers: { [BACKEND_HOST_HEADER]: spawned.hostToken },
                        signal: AbortSignal.timeout(HEALTH_POLL_MS * 4),
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
            { intervalMs: HEALTH_POLL_MS, timeoutMs: HEALTH_TIMEOUT_MS },
        );
        return health;
    };

    const converge = async (): Promise<void> => {
        const run = ++generation;
        clearTimeout(retry);
        kill();
        let collected: Awaited<ReturnType<typeof collect>>;
        try {
            collected = await collect();
        } catch (error) {
            state = { state: "error", detail: errorMessage(error), extensions: [] };
            return;
        }
        if (run !== generation) {
            return;
        }
        reach = collected.tokenReach;
        toolPaths = collected.tools;
        if (collected.runnable.length === 0) {
            state = { state: "stopped", extensions: collected.reported };
            return;
        }
        state = { state: "starting", extensions: collected.reported };
        const port = await freePort();
        const hostToken = randomBytes(32).toString("hex");
        const config: BackendDeviceConfig = {
            port,
            hostToken,
            daemonUrl: `http://127.0.0.1:${daemonPort}`,
            workspaceRoot: services().workspace.root,
            apiVersion: extensionApiVersion,
            extensions: collected.runnable,
        };
        const command = hostCommand();
        const child = spawnAs({ class: "service" }, command.file, command.args, {
            env: { ...process.env, [BACKEND_CONFIG_ENV]: JSON.stringify(config) },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const spawned: SpawnedHost = { child, port, hostToken };
        host = spawned;
        // Both streams feed the daemon log; extension lines carry their own [id] prefix already.
        for (const stream of [child.stdout, child.stderr]) {
            if (stream !== null) {
                createInterface({ input: stream }).on("line", (line) => logger.info(`extension-backend: ${line}`));
            }
        }
        child.on("error", (error) => {
            if (run === generation) {
                state = { state: "error", detail: error.message, extensions: collected.reported };
            }
        });
        child.on("exit", (code, signal) => {
            if (run !== generation || !desired) {
                return;
            }
            // Uninvited death: report it and respawn with backoff rather than leave /x dead forever.
            state = { state: "error", detail: `the backend host exited (${signal ?? code})`, extensions: collected.reported };
            host = undefined;
            retry = setTimeout(() => void converge(), ladder.next());
        });
        const health = await waitHealthy(spawned);
        if (run !== generation) {
            return;
        }
        if (health === undefined) {
            state = { state: "error", detail: "the backend host did not become healthy", extensions: collected.reported };
            return;
        }
        ladder.reset();
        state = { state: "running", extensions: [...health.extensions, ...collected.reported] };
    };

    return {
        start: async () => {
            desired = true;
            await converge();
        },
        restart: () => {
            if (!desired) {
                return;
            }
            clearTimeout(debounce);
            debounce = setTimeout(() => void converge(), RESTART_DEBOUNCE_MS);
        },
        stop: () => {
            desired = false;
            generation += 1;
            clearTimeout(debounce);
            clearTimeout(retry);
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
