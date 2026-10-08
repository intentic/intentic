import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { within } from "@intentic/base/async";
import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { engineBinary } from "../../engines/engine-resolve.js";
import { DAEMON_OWNER, WORKLOAD_ENV } from "../../seams/workload-stamp.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { geminiProviderConfig, OPENCODE_LOCKDOWN_ENV, type OpenCodeGeminiConfig, serverConfig, xaiProviderConfig } from "./opencode-config.js";
import { createXaiCatalog, openCodeCredentials } from "./opencode-credentials.js";
import { type OpenCodeEvents, type OpenCodeListener, openEventStream } from "./opencode-events.js";
import type { McpRemoteConfig, OpenCodeMcpServer } from "./opencode-mcp.js";
import { answerPermission, permissionAskOf, type SessionJudge, type SessionJudges } from "./opencode-permissions.js";
import { processAlive, type ServedProcess, type SpawnServer, spawnOpencodeServe, waitForExit } from "./opencode-serve.js";
import { OPENCODE_XAI_PROVIDER, SEED_XAI_MODELS } from "./xai-models.js";

export { geminiProviderConfig, type OpenCodeGeminiConfig } from "./opencode-config.js";
export type { OpenCodeListener } from "./opencode-events.js";
export type { SessionJudge, SessionJudges } from "./opencode-permissions.js";

// Shared OpenCode runtime: one warm `opencode serve` per container plus its client, used by turn adapters and the Grok
// auth routes. Two providers ride it credentialed oppositely: xai is OpenCode's own OAuth sign-in; gemini's credential
// is the translator's (OpenAI-compatible endpoint), so `connected("gemini")` is never answered here.
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
    readonly xaiModels: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
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

// Provider registration depends on membership and capabilities, not the discovery order or the catalog's default.
const geminiModelSignature = (models: GeminiModels): string =>
    JSON.stringify([...models].sort((a, b) => a.id.localeCompare(b.id)).map(({ id, inputModalities }) => [id, [...inputModalities].sort()]));

// What a failure sentence calls the backend: one opencode serve drives both providers, so the Gemini turn is the Grok
// adapter with a different providerID. Keyed off OpenCode's provider id, since that's what the turn actually carries.
export const openCodeBackendLabel = (providerID: string): string => (providerID === OPENCODE_GEMINI_PROVIDER ? "Google" : "Grok");

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
        const deadline = Date.now() + MCP_CONNECT_MS;
        while (Date.now() < deadline) {
            const listed = await opencode.mcp.list({ location: { directory } });
            const status = listed.data.find((server) => server.name === name)?.status.status;
            if (status !== "pending") {
                return;
            }
            await delay(MCP_POLL_MS);
        }
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
                await delay(MCP_SETTLE_MS);
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
        readonly route?: (provider: "grok" | "gemini", upstream: string) => Promise<string | undefined>;
    } = {},
): OpenCodeService => {
    const {
        gemini,
        route,
        fetchImpl = fetch,
        spawnServer = spawnOpencodeServe,
        makeClient = ({ url, headers }) => OpenCode.make({ baseUrl: url, headers }),
        alive = processAlive,
        idleStopMs = OPENCODE_IDLE_STOP_MS,
    } = options;
    // When anything last used the server, and the clock that stops it once that is long enough ago.
    let lastUsedAt = Date.now();
    let idleClock: NodeJS.Timeout | undefined;
    const opencodeDir = join(xdgDataHome, "opencode");
    const credentials = openCodeCredentials(opencodeDir);
    const xai = createXaiCatalog(opencodeDir, () => credentials.stored(OPENCODE_XAI_PROVIDER), fetchImpl);
    // Whether the server now running was booted behind the gateway; undefined before any boot.
    let bootedShielded: boolean | undefined;
    let bootedGeminiModels: GeminiModels = [];
    // Acquisitions run in order; leases protect setup, helpers and ungated turns as well as judged sessions.
    let acquisitions = Promise.resolve();
    let activeTurns = 0;
    let booting: Promise<Booted> | undefined;
    // Which boot is current: an exit or a lost stream from an older one must not forget its replacement.
    let generation = 0;
    let served: ServedProcess | undefined;
    let serverHandle: { close(): void } | undefined;
    let currentEvents: OpenCodeEvents | undefined;
    const sessionJudges = new Map<string, SessionJudge>();
    const judgeOf = (sessionId: string): SessionJudge | undefined => sessionJudges.get(sessionId);

    const boot = async (knownGeminiModels?: GeminiModels): Promise<Booted> => {
        const own = (generation += 1);
        // xAI stores request/response server-side by default; every known model opts out (xaiProviderConfig). Config is
        // fixed at spawn, so a self-healed model lacks the flag until the next restart.
        const storeOptOut = [...new Set([...SEED_XAI_MODELS, ...(await xai.persisted())])];
        // An acquisition hands over the exact catalog it compared, so a second discovery cannot race the refresh.
        const geminiModels = knownGeminiModels ?? (await readGeminiModels(gemini)) ?? [];
        // Behind the privacy shield, both providers send to its gateway, which forwards where they would have gone.
        const xaiGateway = await route?.("grok", XAI_UPSTREAM);
        const geminiGateway = gemini === undefined ? undefined : await route?.("gemini", gemini.baseUrl);
        const shielded = xaiGateway !== undefined || geminiGateway !== undefined;
        const config = serverConfig({
            ...xaiProviderConfig(storeOptOut, xaiGateway),
            ...geminiProviderConfig(gemini === undefined || geminiGateway === undefined ? gemini : { ...gemini, baseUrl: geminiGateway }, geminiModels),
        });
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
                        // allow(silent-catch): a failed reply just leaves the ask standing, which the turn's watchdog ends
                        void answerPermission(client, judgeOf(ask.sessionID), ask).catch(() => {});
                    }
                },
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
        if (idleStopMs > 0) {
            idleClock ??= idleStopClock(idleStopMs, stopIfIdle);
        }
        return { client, events };
    };

    const stopIfIdle = (): void => {
        const idle = openCodeIdleStop({
            booted: booting !== undefined,
            activeTurns,
            judges: sessionJudges.size,
            lastUsedAt,
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
    const ensure = async (geminiModels?: GeminiModels): Promise<Booted> => {
        lastUsedAt = Date.now();
        await finishStopping();
        booting ??= retryableBoot(boot(geminiModels));
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
    const restart = (models: GeminiModels): Promise<Booted> => {
        // Publish the replacement boot before yielding, so raw client probes also wait for this exact catalog.
        booting = retryableBoot(closeServer().then(() => boot(models)));
        return booting;
    };
    const take = async (model: Parameters<OpenCodeService["acquire"]>[0]): Promise<OpenCodeLease> => {
        // Include this acquisition's asynchronous setup in its lifetime, including privacy-shield checks racing it.
        activeTurns += 1;
        try {
            // Only a Google acquisition reads Google's catalog: a Grok turn never waits on the translator, and a newly
            // listed Google model is registered by the next Google turn that finds the runtime idle.
            const latest = model.providerID === OPENCODE_GEMINI_PROVIDER ? await readGeminiModels(gemini) : undefined;
            // A failed first read already has its answer: do not wait on discovery a second time during boot.
            let booted = await ensure(model.providerID === OPENCODE_GEMINI_PROVIDER ? (latest ?? []) : undefined);
            if (latest !== undefined && latest.length > 0 && geminiModelSignature(latest) !== geminiModelSignature(bootedGeminiModels)) {
                if (activeTurns === 1 && sessionJudges.size === 0) {
                    booted = await restart(latest);
                } else if (model.modelID !== undefined && !bootedGeminiModels.some((row) => row.id === model.modelID)) {
                    throw new Error(
                        `Google's model catalog has refreshed, but its shared runtime is still running other turns. Send again once they finish to use ${model.modelID}.`,
                    );
                }
            }
            let released = false;
            return {
                client: booted.client,
                listen: booted.events.listen,
                release: () => {
                    if (!released) {
                        released = true;
                        activeTurns -= 1;
                        lastUsedAt = Date.now();
                    }
                },
            };
        } catch (error) {
            activeTurns -= 1;
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
        stop: async () => closeServer(),
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
            if (activeTurns === 0 && sessionJudges.size === 0) {
                await closeServer();
                return true;
            }
            // Busy and still routed through the gateway the shield no longer needs: a plain relay, harmless.
            return !wanted;
        },
    };
};
