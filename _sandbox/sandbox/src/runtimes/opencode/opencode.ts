import { dirname, join } from "node:path";
import { pollFor, sleep, within } from "@intentic/base/async";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { engineBinary } from "../../engines/engine-resolve.js";
import { DAEMON_OWNER, WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { geminiProviderConfig, OPENCODE_LOCKDOWN_ENV, type OpenCodeConfig, type OpenCodeGeminiConfig, serverConfig, variantOf, xaiProviderConfig } from "./opencode-config.js";
import { createXaiCatalog, openCodeCredentials } from "./opencode-credentials.js";
import { type OpenCodeEvents, type OpenCodeListener, openEventStream } from "./opencode-events.js";
import type { McpRemoteConfig, OpenCodeMcpServer } from "./opencode-mcp.js";
import { permissionAnswers, permissionAskOf, type SessionJudge, type SessionJudges } from "./opencode-permissions.js";
import { processAlive, type ServedProcess, type SpawnServer, spawnOpencodeServe, waitForExit } from "./opencode-serve.js";
import { shellHost } from "./shell/opencode-shell.js";
import { type OpenCodeRouteEntry, ROUTE_ID_PREFIX, routeLabelOf, routeProviderConfig, routeSignature } from "./hosted/opencode-routes.js";
import { opt } from "../../opt.js";
import { OPENCODE_XAI_PROVIDER, SEED_XAI_MODELS } from "./xai-models.js";

export { geminiProviderConfig, type OpenCodeGeminiConfig } from "./opencode-config.js";
export type { OpenCodeListener } from "./opencode-events.js";
export type { SessionJudge, SessionJudges } from "./opencode-permissions.js";

// Shared OpenCode runtime: one warm `opencode serve` per container plus its client, used by turn adapters and the Grok
// auth routes. Its providers are credentialed two ways: xai is OpenCode's own OAuth sign-in; gemini's credential is the
// translator's (OpenAI-compatible endpoint), and every hosted route's is the daemon's (opencode-routes.ts), so
// `connected` answers only for xai.
export interface OpenCodeLease {
    readonly client: OpenCodeClient;
    // The server's event stream, which every turn on it shares: a listener hears every session's events and picks its own.
    readonly listen: (listener: OpenCodeListener) => () => void;
    // Held through setup and cleanup, not just while a session has a permission judge; idempotent.
    readonly release: () => void;
}

export interface OpenCodeService {
    // Ensures the server is up and returns its client (lazy: the first turn or auth call boots it).
    readonly client: () => Promise<OpenCodeClient>;
    // A turn's client, with Google registrations refreshed once the server is idle. Held until the turn's cleanup ends,
    // including helpers and turns with no permission judge, so a later acquisition cannot restart their server.
    readonly acquire: (model: { readonly providerID: string; readonly modelID?: string }) => Promise<OpenCodeLease>;
    // Shuts the server down; idempotent, and leaves the service able to boot a fresh one. The daemon calls it on its
    // own shutdown, and the service itself once the server has sat idle for OPENCODE_IDLE_STOP_MS (2026-10-05).
    readonly stop: () => Promise<void>;
    // Mounts a turn's MCP servers on its directory and returns their release, which the turn owes once it ends. A server
    // OpenCode could not reach is left out rather than failing the turn.
    readonly mount: (directory: string, servers: readonly OpenCodeMcpServer[]) => Promise<() => Promise<void>>;
    // Where a turn registers who answers its sessions' permission asks, which this server's event stream reads.
    readonly judges: SessionJudges;
    // Whether a provider (e.g. "xai") holds an OAuth sign-in, read where OpenCode keeps it, without booting the server.
    readonly connected: (providerID: string) => Promise<boolean>;
    // Whether OpenCode still holds this session (resume pre-flight, as every other provider has); false on a lost
    // session, a rejection when the server could not be asked, since the probe's caller resumes rather than guessing.
    readonly sessionExists: (sessionId: string, directory: string) => Promise<boolean>;
    // xAI's model catalog plus a default id, always non-empty: live discovery with the OAuth token, else the last
    // persisted catalog, else the compile-time seed. Cached briefly, but never the seed, so a freshened token is
    // retried on the next read.
    // Each model names the reasoning tiers xAI takes for it (xai-models.ts), where it takes any.
    readonly xaiModels: () => Promise<{ models: { id: string; label: string; efforts?: string[] }[]; default: string }>;
    // Persists the models xAI named valid in a "Did you mean" rejection as the last-known-good catalog; works even when
    // REST discovery rejects the token. No-op for an empty/media-only list.
    readonly recordModels: (ids: string[]) => Promise<void>;
    // Signs a provider out: OpenCode's credentials for it, the legacy auth file, and the persisted catalog. This instance
    // is Grok-only.
    readonly disconnect: (providerID: string) => Promise<void>;
    // Whether the running server's providers are routed the way the privacy shield now wants. Provider config is fixed
    // at spawn, so a server booted before the shield changed is restarted here once no turn is using it; false only
    // while a server booted unshielded is still busy and the shield now wants it shielded.
    readonly shielded: () => Promise<boolean>;
    // The variant a turn's effort names on one model of the running server, as its config declared it: undefined where
    // the model declares no such tier (or no server runs), since OpenCode refuses a variant a model lacks.
    readonly variant: (providerID: string, modelID: string, effort: string | undefined) => string | undefined;
}

// Where OpenCode's xAI provider sends its requests unless told otherwise.
const XAI_UPSTREAM = "https://api.x.ai/v1";

// How long `opencode serve` may sit with no turn, no session judge and no call before it is stopped; the next turn boots
// it again in a second. Before this it ran from the first Grok or Gemini turn to the daemon's end.
export const OPENCODE_IDLE_STOP_MS = 30 * 60_000;

// The clock that looks for an idle server, a few times per idle span; unref'd, never what keeps the daemon up.
const idleStopClock = (idleMs: number, look: () => void): NodeJS.Timeout => {
    const clock = setInterval(look, Math.max(1_000, Math.min(idleMs / 6, 5 * 60_000)));
    clock.unref();
    return clock;
};

// A stop that could not finish is retried by the next acquisition (finishStopping), so nothing waits on this one.
const ignored = (): void => undefined;

/** Whether a booted server has been idle long enough to stop: nothing holds it and nothing used it for `idleMs`. */
export const openCodeIdleStop = (state: {
    readonly booted: boolean;
    readonly activeTurns: number;
    readonly judges: number;
    readonly lastUsedAt: number;
    readonly now: number;
    readonly idleMs: number;
}): boolean => state.booted && state.activeTurns === 0 && state.judges === 0 && state.now - state.lastUsedAt >= state.idleMs;

type GeminiModels = Awaited<ReturnType<OpenCodeGeminiConfig["models"]>>;

// A refresh must not park every acquisition behind an unresponsive translator, before a turn has a watchdog.
const CATALOG_TIMEOUT_MS = 5_000;
const readGeminiModels = async (gemini: OpenCodeGeminiConfig | undefined): Promise<GeminiModels | undefined> => {
    if (gemini === undefined) {
        return undefined;
    }
    try {
        return await within(gemini.models(), CATALOG_TIMEOUT_MS, undefined);
    } catch {
        // allow(silent-catch): failed discovery retains the working registration or lets Grok boot without Google
        return undefined;
    }
};

// Whether a served server's process still runs; a stand-in with no process is taken at its word.
const serving =
    (server: { readonly process: ServedProcess | undefined }, alive: (pid: number) => boolean) =>
    (): boolean =>
        server.process === undefined || alive(server.process.pid);

interface BootedProviders {
    providers: NonNullable<OpenCodeConfig["providers"]>;
}
const variantFrom =
    (booted: BootedProviders): OpenCodeService["variant"] =>
    (providerID, modelID, effort) =>
        variantOf(booted.providers, providerID, modelID, effort);

// Every provider the server is configured with. Behind the privacy shield each sends to its gateway, which forwards where
// it would have gone; `shielded` says whether any does.
const providersFor = async (input: {
    readonly route: ((provider: string, upstream: string) => Promise<string | undefined>) | undefined;
    readonly gemini: OpenCodeGeminiConfig | undefined;
    readonly geminiModels: GeminiModels;
    readonly storeOptOut: readonly string[];
    readonly hosted: readonly OpenCodeRouteEntry[];
}): Promise<{ readonly providers: NonNullable<OpenCodeConfig["providers"]>; readonly shielded: boolean }> => {
    const { route, gemini } = input;
    const xaiGateway = await route?.("grok", XAI_UPSTREAM);
    const geminiGateway = gemini === undefined ? undefined : await route?.("gemini", gemini.baseUrl);
    const routed = await Promise.all(input.hosted.map(async (entry) => ({ ...entry, ...opt("gateway", await route?.(entry.shield, entry.base)) })));
    const geminiConfig = gemini === undefined || geminiGateway === undefined ? gemini : { ...gemini, baseUrl: geminiGateway };
    return {
        providers: {
            ...xaiProviderConfig(input.storeOptOut, xaiGateway),
            ...geminiProviderConfig(geminiConfig, input.geminiModels),
            ...routeProviderConfig(routed),
        },
        shielded: xaiGateway !== undefined || geminiGateway !== undefined || routed.some((entry) => entry.gateway !== undefined),
    };
};

// How many turns hold the server, and when anything last used it: what the idle stop reads.
interface ServerUse {
    turns: number;
    lastAt: number;
}

// A lease on a booted server, counted in `use` until the turn lets go; letting go twice counts once.
const leaseOn = (booted: Booted, use: ServerUse): OpenCodeLease => {
    let released = false;
    return {
        client: booted.client,
        listen: booted.events.listen,
        release: () => {
            if (!released) {
                released = true;
                use.turns -= 1;
                use.lastAt = Date.now();
            }
        },
    };
};

// Whether a hosted turn's acquisition restarts the server onto the routes it just read: when they changed and nothing
// else runs on it. Busy, a turn whose provider or model the running server lacks is refused rather than sent where
// OpenCode would answer that it knows no such model; one the server already holds runs as it is.
const restartsForRoutes = (
    latest: readonly OpenCodeRouteEntry[] | undefined,
    booted: readonly OpenCodeRouteEntry[],
    model: { readonly providerID: string; readonly modelID?: string },
    idle: boolean,
): boolean => {
    if (latest === undefined || routeSignature(latest) === routeSignature(booted)) {
        return false;
    }
    if (idle) {
        return true;
    }
    const held = booted.find((entry) => entry.id === model.providerID);
    if (held === undefined || (model.modelID !== undefined && !held.models.some((row) => row.id === model.modelID))) {
        throw new Error(`${openCodeBackendLabel(model.providerID)}'s connection changed while OpenCode's shared server was running other turns. Send again once they finish.`);
    }
    return false;
};

// What a boot is told of the catalogs an acquisition already read, so it does not read them a second time.
interface KnownCatalogs {
    readonly gemini?: GeminiModels;
    readonly routes?: readonly OpenCodeRouteEntry[];
}

// Same bound and same answer to a failure as Google's: the server boots with the routes it had, or none.
const readRoutes = async (routes: (() => Promise<readonly OpenCodeRouteEntry[]>) | undefined): Promise<readonly OpenCodeRouteEntry[] | undefined> => {
    if (routes === undefined) {
        return undefined;
    }
    try {
        return await within(routes(), CATALOG_TIMEOUT_MS, undefined);
    } catch {
        // allow(silent-catch): routes that can't be read now leave the server on the ones it booted with, or none
        return undefined;
    }
};

// Provider registration depends on membership, capabilities and reasoning tiers, not the discovery order or the
// catalog's default.
const geminiModelSignature = (models: GeminiModels): string =>
    JSON.stringify(
        [...models].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, inputModalities, efforts }) => [id, [...inputModalities].sort(), [...(efforts ?? [])]]),
    );

// What a failure sentence calls the backend: one opencode serve drives every provider, so a Gemini or hosted turn is the
// Grok adapter with a different providerID. Keyed off OpenCode's provider id, since that's what the turn actually carries.
export const openCodeBackendLabel = (providerID: string): string =>
    providerID === OPENCODE_GEMINI_PROVIDER ? "Google" : (routeLabelOf(providerID) ?? "Grok");

// How long a just-added server gets to connect; past it the turn goes without its tools rather than waiting longer.
const MCP_CONNECT_MS = 15_000;
const MCP_POLL_MS = 25;
// OpenCode rebuilds a directory's tool list 100ms after a server's tools change (2.0.26), and a session created before
// that sees the old list. So a turn whose servers just changed waits this long past the connect before it prompts.
const MCP_SETTLE_MS = 300;

// The MCP servers turns hold in each directory. OpenCode keeps one client per server name there, and two turns of one
// conversation can hold the same name at once, so each name's client carries its newest holder's config (that turn's
// bearer) and is removed once the last holder lets go. Changes to one name run in order, so the client ends on the
// newest holder whichever call lands first.
const mcpHolds = (client: () => Promise<OpenCodeClient>) => {
    const holders = new Map<string, { readonly id: symbol; readonly config: McpRemoteConfig }[]>();
    // Which holder each name's client was last set to; absent once removed.
    const applied = new Map<string, symbol>();
    const settling = new Map<string, Promise<boolean>>();
    const keyOf = (directory: string, name: string): string => `${directory}\u0000${name}`;

    const connectedOrGone = async (opencode: OpenCodeClient, directory: string, name: string): Promise<void> => {
        await pollFor(
            async () => {
                const listed = await opencode.mcp.list({ location: { directory } });
                const status = listed.data.find((server) => server.name === name)?.status.status;
                // add() schedules reconciliation: the name can be absent before its pending entry appears.
                return status === undefined || status === "pending" ? undefined : true;
            },
            { intervalMs: MCP_POLL_MS, until: Date.now() + MCP_CONNECT_MS },
        );
    };

    // Brings one name's client in line with its newest holder, after whatever change to it is already under way.
    // Resolves to whether this call changed what the directory offers.
    const settle = (opencode: OpenCodeClient, directory: string, name: string): Promise<boolean> => {
        const key = keyOf(directory, name);
        const next = (settling.get(key) ?? Promise.resolve(false))
            .then(async () => {
                const newest = holders.get(key)?.at(-1);
                if (applied.get(key) === newest?.id) {
                    return false;
                }
                if (newest === undefined) {
                    applied.delete(key);
                    await opencode.mcp.remove({ server: name, location: { directory } });
                    return true;
                }
                applied.set(key, newest.id);
                await opencode.mcp.add({ server: name, location: { directory }, config: newest.config });
                await connectedOrGone(opencode, directory, name);
                return true;
            })
            // allow(silent-catch): a server OpenCode could not mount is a tool the turn goes without, not a failed turn
            .catch(() => false);
        settling.set(key, next);
        void next.then(() => {
            if (settling.get(key) === next) {
                settling.delete(key);
            }
        });
        return next;
    };

    return {
        mount: async (directory: string, servers: readonly OpenCodeMcpServer[]): Promise<() => Promise<void>> => {
            if (servers.length === 0) {
                return async () => {};
            }
            const opencode = await client();
            const id = Symbol("mount");
            for (const server of servers) {
                const key = keyOf(directory, server.name);
                holders.set(key, [...(holders.get(key) ?? []), { id, config: server.config }]);
            }
            const changed = await Promise.all(servers.map((server) => settle(opencode, directory, server.name)));
            if (changed.some(Boolean)) {
                await sleep(MCP_SETTLE_MS);
            }
            let released = false;
            return async () => {
                if (released) {
                    return;
                }
                released = true;
                for (const server of servers) {
                    const key = keyOf(directory, server.name);
                    const left = (holders.get(key) ?? []).filter((holder) => holder.id !== id);
                    if (left.length === 0) {
                        holders.delete(key);
                    } else {
                        holders.set(key, left);
                    }
                }
                await Promise.all(servers.map((server) => settle(opencode, directory, server.name)));
            };
        },
        // A stopped server took every client with it.
        forget: (): void => {
            holders.clear();
            applied.clear();
            settling.clear();
        },
    };
};

// One booted server: its client, its event stream, and the process behind them.
interface Booted {
    readonly client: OpenCodeClient;
    readonly events: OpenCodeEvents;
}

// Options bag rather than more positionals, so a production option never has to land after the test's fetch-injection
// seam.
export const createOpenCodeService = (
    xdgDataHome: string,
    options: {
        readonly gemini?: OpenCodeGeminiConfig;
        readonly fetchImpl?: typeof fetch;
        readonly workspaceRoot?: string;
        // Which port the server listens on; absent lets the kernel pick a free one, which the server then names.
        readonly port?: number;
        // What starts `opencode serve`; the real spawn unless a test stands in for it.
        readonly spawnServer?: SpawnServer;
        // What talks to a started server; OpenCode's own client unless a test stands in for it.
        readonly makeClient?: (server: { readonly url: string; readonly headers: Readonly<Record<string, string>> }) => OpenCodeClient;
        // Whether the served process still runs; the real process table unless a test stands in for it.
        readonly alive?: (pid: number) => boolean;
        // How long an idle server is kept before it is stopped; 0 keeps it for the service's life.
        readonly idleStopMs?: number;
        // The privacy shield's gateway base URL for a provider's requests, or undefined while the shield is off.
        readonly route?: (provider: string, upstream: string) => Promise<string | undefined>;
        // Every route OpenCode could host now (opencode-routes.ts), each written into the server's config at spawn;
        // absent hosts none, as a test standing in for the daemon does.
        readonly routes?: () => Promise<readonly OpenCodeRouteEntry[]>;
        // Where the daemon's shell script and the socket it asks over live (shell/opencode-shell.ts); absent leaves OpenCode
        // its own shell, as a test standing in for the server does.
        readonly shellDir?: string;
    } = {},
): OpenCodeService => {
    const {
        gemini,
        route,
        routes,
        fetchImpl = fetch,
        spawnServer = spawnOpencodeServe,
        makeClient = ({ url, headers }) => OpenCode.make({ baseUrl: url, headers }),
        alive = processAlive,
        idleStopMs = OPENCODE_IDLE_STOP_MS,
    } = options;
    // When anything last used the server, and the clock that stops it once that is long enough ago.
    const use: ServerUse = { turns: 0, lastAt: Date.now() };
    let idleClock: NodeJS.Timeout | undefined;
    const opencodeDir = join(xdgDataHome, "opencode");
    const credentials = openCodeCredentials(opencodeDir);
    const xai = createXaiCatalog(opencodeDir, () => credentials.stored(OPENCODE_XAI_PROVIDER), fetchImpl);
    // Whether the server now running was booted behind the gateway; undefined before any boot.
    let bootedShielded: boolean | undefined;
    let bootedGeminiModels: GeminiModels = [];
    let bootedRoutes: readonly OpenCodeRouteEntry[] = [];
    // The providers the running server was configured with, which decide what variant a turn's effort can name.
    const configured: BootedProviders = { providers: {} };
    // Acquisitions run in order; leases protect setup, helpers and ungated turns as well as judged sessions.
    let acquisitions = Promise.resolve();
    let booting: Promise<Booted> | undefined;
    // Which boot is current: an exit or a lost stream from an older one must not forget its replacement.
    let generation = 0;
    let served: ServedProcess | undefined;
    let serverHandle: { close(): void } | undefined;
    let currentEvents: OpenCodeEvents | undefined;
    const sessionJudges = new Map<string, SessionJudge>();
    const asks = permissionAnswers(sessionJudges);
    // The shell every session's commands run through, placed by session on the judges registered here.
    const shell = shellHost(options.shellDir, sessionJudges);

    const boot = async (known: KnownCatalogs = {}): Promise<Booted> => {
        const own = (generation += 1);
        // xAI stores request/response server-side by default; every known model opts out (xaiProviderConfig). Config is
        // fixed at spawn, so a self-healed model lacks the flag until the next restart.
        const storeOptOut = [...new Set([...SEED_XAI_MODELS, ...(await xai.persisted())])];
        // An acquisition hands over the exact catalog it compared, so a second discovery cannot race the refresh.
        const geminiModels = known.gemini ?? (await readGeminiModels(gemini)) ?? [];
        const hosted = known.routes ?? (await readRoutes(routes)) ?? [];
        const { providers, shielded } = await providersFor({ route, gemini, geminiModels, storeOptOut, hosted });
        const config = serverConfig(providers, await shell.path());
        const stored = await engineBinary("opencode");
        const server = await spawnServer({
            binary: stored ?? "opencode",
            port: options.port ?? 0,
            env: {
                ...OPENCODE_LOCKDOWN_ENV,
                // Inline config is loaded last, so it outranks every config file a person or a repo could write.
                OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
                // Where OpenCode keeps its database (sessions and credentials), under the workspace's .intentic so it
                // survives a restart.
                XDG_DATA_HOME: xdgDataHome,
                // An `opencode` the server starts for itself is the same pinned one.
                ...(stored === undefined ? {} : { PATH: `${dirname(stored)}:${process.env["PATH"] ?? ""}` }),
                // Shared by every conversation, so the daemon's; stamped so a later boot ends one a dead daemon left
                // running (system/boot/generation-sweep.ts).
                [WORKLOAD_ENV]: DAEMON_OWNER,
            },
        });
        const client = makeClient(server);
        // Opened before the boot is handed to anyone, so no turn can prompt before its events have a reader.
        let events: OpenCodeEvents;
        try {
            events = await openEventStream(client, {
                onEvent: (event) => {
                    const ask = permissionAskOf(event);
                    if (ask !== undefined) {
                        asks.answer(client, ask);
                    }
                },
                // A dropped stream is reopened only while this boot's server runs (a stopped one's stream is closed
                // first, so it never asks).
                alive: serving(server, alive),
                // An ask raised while the stream was down was never heard: the judged sessions' standing asks are
                // read back and answered.
                onResume: asks.standing(client),
                // A server whose stream is gone cannot tell any turn when it ends: the next acquisition boots afresh.
                ended: () => {
                    if (generation === own) {
                        void closeServer().then(ignored, ignored);
                    }
                },
            });
        } catch (error) {
            server.close();
            if (server.process !== undefined) {
                await waitForExit(server.process, alive).catch(ignored);
            }
            throw error;
        }
        // Stopped while it started (the daemon's shutdown, a privacy change): this server is nobody's, so it goes.
        if (generation !== own) {
            events.close();
            server.close();
            if (server.process !== undefined) {
                await waitForExit(server.process, alive).catch(ignored);
            }
            throw new Error("OpenCode was stopped while it was starting.");
        }
        server.onExit((summary) => {
            // A turn mid-prompt hears it now, rather than from its watchdog once the silence runs out.
            events.lose(new Error(summary));
            if (generation === own) {
                served = undefined;
                forget();
            }
        });
        served = server.process;
        serverHandle = server;
        currentEvents = events;
        bootedShielded = shielded;
        bootedGeminiModels = geminiModels;
        bootedRoutes = hosted;
        configured.providers = providers;
        if (idleStopMs > 0) {
            idleClock ??= idleStopClock(idleStopMs, stopIfIdle);
        }
        return { client, events };
    };

    const stopIfIdle = (): void => {
        const idle = openCodeIdleStop({
            booted: booting !== undefined,
            activeTurns: use.turns,
            judges: sessionJudges.size,
            lastUsedAt: use.lastAt,
            now: Date.now(),
            idleMs: idleStopMs,
        });
        if (idle) {
            void closeServer().then(ignored, ignored);
        }
    };

    let stoppingServer: ServedProcess | undefined;
    let stopping: Promise<void> | undefined;
    // A timed-out stop keeps its process: a later acquisition retries the exit wait rather than running two servers.
    const finishStopping = (): Promise<void> => {
        if (stoppingServer === undefined) {
            return Promise.resolve();
        }
        const server = stoppingServer;
        stopping ??= waitForExit(server, alive)
            .then(() => {
                stoppingServer = undefined;
            })
            .finally(() => {
                stopping = undefined;
            });
        return stopping;
    };
    // Memoize the in-flight boot as well as the finished client. A failed boot stays retryable; a server that exited
    // or lost its stream has already been forgotten, so the next caller boots a fresh one.
    const ensure = async (known?: KnownCatalogs): Promise<Booted> => {
        use.lastAt = Date.now();
        await finishStopping();
        booting ??= retryableBoot(boot(known));
        return booting;
    };
    const mounts = mcpHolds(async () => (await ensure()).client);
    // Everything that belonged to the last server: its client, its stream and its mounted MCP clients.
    function forget(): void {
        clearInterval(idleClock);
        idleClock = undefined;
        booting = undefined;
        bootedShielded = undefined;
        bootedGeminiModels = [];
        bootedRoutes = [];
        configured.providers = {};
        currentEvents?.close();
        currentEvents = undefined;
        mounts.forget();
    }
    const closeServer = (): Promise<void> => {
        // Bumped first, so this server's own exit and lost stream are read as the old boot's.
        generation += 1;
        serverHandle?.close();
        serverHandle = undefined;
        stoppingServer ??= served;
        served = undefined;
        forget();
        return finishStopping();
    };
    // A failed boot is forgotten so the next call tries again, but only while it is still the memoized one: a boot
    // stopped while starting fails after a later call has published its own, which must not be erased.
    // The attempt itself is what is memoized and what callers await, so its failure still reaches them.
    const retryableBoot = (attempt: Promise<Booted>): Promise<Booted> => {
        void attempt.then(undefined, () => {
            if (booting === attempt) {
                booting = undefined;
            }
        });
        return attempt;
    };
    // Restarts onto `next`, keeping what the running server already holds of whichever catalog this did not reread.
    const restart = (next: KnownCatalogs): Promise<Booted> => {
        const known: KnownCatalogs = { gemini: next.gemini ?? bootedGeminiModels, routes: next.routes ?? bootedRoutes };
        // Publish the replacement boot before yielding, so raw client probes also wait for this exact catalog.
        booting = retryableBoot(closeServer().then(() => boot(known)));
        return booting;
    };
    const take = async (model: Parameters<OpenCodeService["acquire"]>[0]): Promise<OpenCodeLease> => {
        // Include this acquisition's asynchronous setup in its lifetime, including privacy-shield checks racing it.
        use.turns += 1;
        try {
            // A hosted route's acquisition rereads the routes; Google's, Google's catalog. A Grok turn waits on neither, and a
            // newly listed model is registered by the next turn of its own provider that finds the runtime idle.
            if (model.providerID.startsWith(ROUTE_ID_PREFIX)) {
                const hosted = await readRoutes(routes);
                const running = await ensure({ routes: hosted ?? [] });
                const idle = use.turns === 1 && sessionJudges.size === 0;
                return leaseOn(hosted !== undefined && restartsForRoutes(hosted, bootedRoutes, model, idle) ? await restart({ routes: hosted }) : running, use);
            }
            const latest = model.providerID === OPENCODE_GEMINI_PROVIDER ? await readGeminiModels(gemini) : undefined;
            // A failed first read already has its answer: do not wait on discovery a second time during boot.
            let booted = await ensure(model.providerID === OPENCODE_GEMINI_PROVIDER ? { gemini: latest ?? [] } : undefined);
            if (latest !== undefined && latest.length > 0 && geminiModelSignature(latest) !== geminiModelSignature(bootedGeminiModels)) {
                if (use.turns === 1 && sessionJudges.size === 0) {
                    booted = await restart({ gemini: latest });
                } else if (model.modelID !== undefined && !bootedGeminiModels.some((row) => row.id === model.modelID)) {
                    throw new Error(
                        `Google's model catalog has refreshed, but its shared runtime is still running other turns. Send again once they finish to use ${model.modelID}.`,
                    );
                }
            }
            return leaseOn(booted, use);
        } catch (error) {
            use.turns -= 1;
            throw error;
        }
    };
    const acquire: OpenCodeService["acquire"] = (model) => {
        const next = acquisitions.then(() => take(model));
        // A refused acquisition must not poison the next turn's place in the queue.
        acquisitions = next.then(
            () => {},
            () => {},
        );
        return next;
    };

    return {
        client: async () => (await ensure()).client,
        acquire,
        stop: async () => {
            await closeServer();
            await shell.close();
        },
        mount: mounts.mount,
        judges: {
            register: (sessionId, judge) => {
                sessionJudges.set(sessionId, judge);
            },
            release: (sessionId) => {
                sessionJudges.delete(sessionId);
            },
        },
        connected: credentials.connected,
        sessionExists: async (sessionId) => {
            const { client } = await ensure();
            try {
                await client.session.get({ sessionID: sessionId });
                return true;
            } catch (error) {
                if ((error as { readonly name?: unknown }).name !== "SessionNotFoundError") {
                    throw error;
                }
            }
            // OpenCode 2 copies an OpenCode 1 history into its own tables in the background on its first boot; a session
            // missing while that runs is not lost, so the caller is told it could not be checked rather than that it is gone.
            const migration = await client.migration.v1.status();
            if (migration.status === "required" || migration.status === "running") {
                throw new Error("OpenCode is still moving its earlier sessions over. Send again in a moment.");
            }
            return false;
        },
        xaiModels: xai.models,
        variant: variantFrom(configured),
        recordModels: xai.record,
        disconnect: async (providerID) => {
            // The server holds the sign-in in its database and its memory alike; removing it there forgets both.
            const { client } = await ensure();
            const listed = await client.credential.list();
            await Promise.all(listed.filter((entry) => entry.integrationID === providerID).map((entry) => client.credential.remove({ credentialID: entry.id })));
            await Promise.all([xai.forget(), credentials.forgetLegacy()]);
        },
        shielded: async () => {
            const wanted = (await route?.("grok", XAI_UPSTREAM)) !== undefined;
            if (booting === undefined || bootedShielded === undefined || bootedShielded === wanted) {
                return true;
            }
            // Idle: the next turn boots routed the way the shield now wants. Judges cover legacy callers too.
            if (use.turns === 0 && sessionJudges.size === 0) {
                await closeServer();
                return true;
            }
            // Busy and still routed through the gateway the shield no longer needs: a plain relay, harmless.
            return !wanted;
        },
    };
};
