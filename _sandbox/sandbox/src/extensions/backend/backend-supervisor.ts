import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api";
import type { Logger } from "pino";
import { tokenEquals } from "../../auth/auth.js";
import { extensionRuntimeAbsent, RUNTIME_ABSENT_DETAIL } from "../extension-readiness.js";
import { enabledExtensions, type ExtensionHost } from "../installed-extensions.js";
import {
    BACKEND_CONFIG_ENV,
    BACKEND_HOST_HEADER,
    type BackendExtensionStatus,
    type BackendHealth,
    type BackendHostConfig,
    type BackendHostExtension,
} from "./backend-host-config.js";

/* THE BACKEND HOST'S SUPERVISOR — the daemon-side half of the extension backend system.
 *
 * Extension backends run in ONE separate node process (backend-host-main.ts), never in the daemon, because
 * loaded code cannot be unloaded: the off switch, an install at a new sha and a live-edited workspace
 * extension all require the process holding the old code to die, and the process that dies must not be the
 * one holding chat, terminals and file sync. So every lifecycle moment is a RESTART of the host — a couple of
 * seconds during which /x routes answer 503 with a readable reason — and the daemon supervises: spawn, wait
 * for health, forward output into its own log, respawn with backoff when the host dies uninvited.
 *
 * It also owns the two credentials of the seam. The HOST token is how the host knows a request came through
 * the daemon's gate rather than from a neighbor on loopback. The PER-EXTENSION tokens are what each backend's
 * api.daemon presents back — verified here against the manifest's `permissions.daemon`, which is what makes a
 * backend's reach into the core declared and refusable rather than ambient (the all-routes panel token this
 * deliberately does not reuse). Tokens are per boot and per extension; a disabled extension's token stops
 * verifying at the restart that removes it. */

// What one extension's backend row reports — the host's own /health answer, plus the two states only the
// supervisor can know (a server declared but not runnable here; an engines mismatch).
export type BackendStatus = BackendExtensionStatus | { readonly id: string; readonly state: "absent" | "incompatible"; readonly detail: string };

export interface ExtensionBackendState {
    // stopped — no extension ships a backend (or stop() was called); starting/running/error — the host's own arc.
    readonly state: "stopped" | "starting" | "running" | "error";
    readonly detail?: string;
    readonly extensions: readonly BackendStatus[];
}

export interface ExtensionBackend {
    // Converge now: enumerate enabled backends, respawn the host on the new set. Boot calls this once;
    // everything else goes through restart().
    start(): Promise<void>;
    // Debounced converge — the toggle, an install, a workspace-extension edit. Safe to call in bursts.
    restart(): void;
    stop(): void;
    status(): ExtensionBackendState;
    statusOf(id: string): BackendStatus | undefined;
    // Where the /x proxy forwards while the host is up; undefined answers 503 with the current state's detail.
    proxyTarget(): { readonly port: number; readonly hostToken: string } | undefined;
    // The extension grant's resolver (auth/grants.ts): a minted backend token → its declared daemon reach.
    verifyExtensionToken(presented: string): { readonly permissions: readonly string[] } | undefined;
}

// An OS-assigned free loopback port (the managed-processes pattern): a tiny TOCTOU window before the host
// binds it, fine for one supervised child that owns the port a moment later.
const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = net.createServer();
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            server.close(() => resolve(port));
        });
    });

/* The host entry, resolved beside THIS file so dev and dist stay one code path: compiled, both are .js in
 * dist/ and node runs the entry directly; under tsx (dev, tests) both are .ts and the child needs the same
 * loader, resolved by absolute path so the spawn's cwd doesn't decide whether dev works. */
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
    /* Per-extension backend tokens, minted once per daemon lifetime so a host restart doesn't invalidate a
     * request already in flight. What a token REACHES is resolved per restart (`reach` below), so a disabled
     * extension's token verifies nothing even though its bytes still exist. */
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
    // token → the declared permissions.daemon of the extension it was minted for, as of the last converge.
    let reach = new Map<string, readonly string[]>();

    let generation = 0;
    let desired = false;
    let host: SpawnedHost | undefined;
    let state: ExtensionBackendState = { state: "stopped", extensions: [] };
    let backoffMs = BACKOFF_START_MS;
    let debounce: NodeJS.Timeout | undefined;
    let retry: NodeJS.Timeout | undefined;

    const kill = (): void => {
        if (host !== undefined) {
            host.child.kill();
            host = undefined;
        }
    };

    // The enabled extensions that ship a backend, split into runnable ones and rows only this side can
    // report — plus each runnable one's declared daemon reach, which stays on THIS side of the seam (the
    // daemon gates; the host never needs to know what it may ask for).
    const collect = async (): Promise<{
        runnable: BackendHostExtension[];
        reported: BackendStatus[];
        tokenReach: Map<string, readonly string[]>;
    }> => {
        const runnable: BackendHostExtension[] = [];
        const reported: BackendStatus[] = [];
        const tokenReach = new Map<string, readonly string[]>();
        for (const extension of await enabledExtensions(services())) {
            const server = extension.manifest.server;
            if (server === undefined) {
                continue;
            }
            if (!satisfiesEngines(extension.manifest.engines.intentic, extensionApiVersion)) {
                reported.push({
                    id: extension.id,
                    state: "incompatible",
                    detail: `needs intentic ${extension.manifest.engines.intentic}; this daemon provides ${extensionApiVersion}`,
                });
                continue;
            }
            // The processes spawn gate's honesty rule, applied to the backend: a core image bakes the
            // manifest without the tree behind it, and not loading is the only true answer.
            if (await extensionRuntimeAbsent(extension)) {
                reported.push({ id: extension.id, state: "absent", detail: RUNTIME_ABSENT_DETAIL });
                continue;
            }
            const daemonToken = tokenFor(extension.id);
            tokenReach.set(daemonToken, extension.manifest.permissions?.daemon ?? []);
            runnable.push({ id: extension.id, dir: extension.dir, server, daemonToken });
        }
        return { runnable, reported, tokenReach };
    };

    const waitHealthy = async (spawned: SpawnedHost, until: number): Promise<BackendHealth | undefined> => {
        while (Date.now() < until) {
            if (spawned.child.exitCode !== null) {
                return undefined;
            }
            try {
                const response = await fetch(`http://127.0.0.1:${spawned.port}/health`, {
                    headers: { [BACKEND_HOST_HEADER]: spawned.hostToken },
                    signal: AbortSignal.timeout(HEALTH_POLL_MS * 4),
                });
                if (response.ok) {
                    return (await response.json()) as BackendHealth;
                }
            } catch {
                // Not up yet — the poll IS the wait.
            }
            await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
        }
        return undefined;
    };

    const converge = async (): Promise<void> => {
        const run = ++generation;
        clearTimeout(retry);
        kill();
        let collected: { runnable: BackendHostExtension[]; reported: BackendStatus[]; tokenReach: Map<string, readonly string[]> };
        try {
            collected = await collect();
        } catch (error) {
            state = { state: "error", detail: error instanceof Error ? error.message : String(error), extensions: [] };
            return;
        }
        if (run !== generation) {
            return;
        }
        reach = collected.tokenReach;
        if (collected.runnable.length === 0) {
            state = { state: "stopped", extensions: collected.reported };
            return;
        }
        state = { state: "starting", extensions: collected.reported };
        const port = await freePort();
        const hostToken = randomBytes(32).toString("hex");
        const config: BackendHostConfig = {
            port,
            hostToken,
            daemonUrl: `http://127.0.0.1:${daemonPort}`,
            workspaceRoot: services().workspace.root,
            apiVersion: extensionApiVersion,
            extensions: collected.runnable,
        };
        const command = hostCommand();
        const child = spawn(command.file, command.args, {
            env: { ...process.env, [BACKEND_CONFIG_ENV]: JSON.stringify(config) },
            stdio: ["ignore", "pipe", "pipe"],
        });
        const spawned: SpawnedHost = { child, port, hostToken };
        host = spawned;
        // Both streams into the daemon log, attributed: extension log lines carry their own [id] prefix.
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
            // Uninvited death — report it and respawn with backoff, so a crash-looping extension costs a log
            // line every few seconds instead of a dead /x namespace forever.
            state = { state: "error", detail: `the backend host exited (${signal ?? code})`, extensions: collected.reported };
            host = undefined;
            retry = setTimeout(() => void converge(), backoffMs);
            backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
        });
        const health = await waitHealthy(spawned, Date.now() + HEALTH_TIMEOUT_MS);
        if (run !== generation) {
            return;
        }
        if (health === undefined) {
            state = { state: "error", detail: "the backend host did not become healthy", extensions: collected.reported };
            return;
        }
        backoffMs = BACKOFF_START_MS;
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
        verifyExtensionToken: (presented) => {
            for (const [token, permissions] of reach) {
                if (tokenEquals(presented, token)) {
                    return { permissions };
                }
            }
            return undefined;
        },
    };
};
