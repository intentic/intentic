import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sleep } from "@intentic/base/async";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { ListenerGatewayPhase, ListenerStatus } from "@intentic/sandbox-contract";
import { type DaemonClient, createDaemonClient } from "./daemon.js";
import type { GatewayCtx } from "./context.js";
import { createLog } from "./log.js";

// The connector gateway shell: a baked extension's autoStart process that reconciles a connector's desired connections
// against the daemon's listener state, reports status on a cadence, serves /health and the connector's control routes,
// and shuts down on SIGTERM/SIGINT/SIGHUP. The daemon holds no provider connection; the gateway does.

// How long a fatal connect (revoked token, missing intent, webhook conflict) pauses reconnecting.
const FATAL_RETRY_MS = 300_000;
const RECONCILE_MS = 30_000;
const STATUS_MS = 30_000;
// How long a close may hold up shutdown before it proceeds anyway.
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface ConnectorEntry<TConfig> {
    readonly id: string;
    readonly config: TConfig;
}

// What the shell knows about one slot when a connector computes its status phase or drop decision.
export interface SlotView<THandle> {
    // Whether the gateway should be holding connections: an enabled automation, or the connector opted in.
    readonly holding: boolean;
    // Whether any connection is desired right now (whatsapp: none until a connector has a phone).
    readonly anyDesired: boolean;
    readonly handle: THandle | undefined;
    readonly connecting: boolean;
}

export type CloseReason = "superseded" | "dead" | "shutdown";

// A delivery refusal whose message is meant for the owner; any other error's message or stack stays in the gateway log
// only.
export class GatewayRefusal extends Error {
    readonly response: string;

    constructor(response: string) {
        super(response);
        this.name = "GatewayRefusal";
        this.response = response;
    }
}

export const deliveryErrorResponse = (provider: string, error: unknown): string =>
    error instanceof GatewayRefusal ? error.response : `the ${provider} connector could not deliver that message`;

// The per-provider half of a gateway, returned by the spec's create(ctx), closing over the listener and connection pool
// it builds.
export interface GatewayHooks<TConfig, THandle> {
    // slot id → config for connections that should exist (filtered complete); discord keys by bot token to dedupe.
    readonly desired: (connectors: ReadonlyArray<ConnectorEntry<TConfig>>) => ReadonlyArray<readonly [string, TConfig]>;
    // The connection's identity: a config edit that changes it forces a reconnect; also the fatal-backoff key.
    readonly keyOf: (config: TConfig) => string;
    readonly open: (slotId: string, config: TConfig) => Promise<THandle>;
    readonly close: (slotId: string, handle: THandle, reason: CloseReason) => void | Promise<void>;
    // Whether a held connection is still good; false lets a dead slot be reopened instead of trusted forever.
    readonly alive?: (slotId: string, handle: THandle) => boolean;
    // Maps an unfixable failure to the sentence the owner sees; undefined means transient, retry with no backoff.
    readonly fatal?: (error: unknown) => string | undefined;
    // The slot a connector capability's status row reads (default: its own id; discord: its bot token).
    readonly slotIdOf?: (connector: ConnectorEntry<TConfig>) => string;
    // Overrides the derived phase (discord probes its client pool; whatsapp stays "connecting" while pairing).
    readonly phase?: (connector: ConnectorEntry<TConfig>, view: SlotView<THandle>) => ListenerGatewayPhase;
    // Per-gateway extras riding the status snapshot (discord: voice + whisper presence; whatsapp: pairing codes).
    readonly statusExtras?: () => Omit<ListenerStatus, "connections">;
    // Delivers a message into a channel between turns; channelId is the provider's own listener-reported id.
    readonly deliver?: (channelId: string, text: string) => Promise<void>;
    // The connector's loopback control surface; undefined means unmatched, throwing sends a 500 with the message.
    readonly routes?: (req: IncomingMessage, body: () => Promise<string>) => Promise<{ status?: number; body: string } | undefined>;
    // Overrides the default shutdown (close every held connection); use for a connector with its own teardown.
    readonly shutdown?: (wired: ReadonlyMap<string, THandle>) => void | Promise<void>;
}

// Shell-owned levers a connector's callbacks pull mid-life: a poll loop that dies after a successful open can
// still report the same fatal backoff an open failure would.
export interface GatewayControl {
    readonly markFatal: (key: string, detail: string) => void;
}

export interface GatewaySpec<TConfig extends { readonly provider: string }, THandle> {
    readonly provider: string;
    // Hold connections while a connector exists, automations or not (whatsapp: pairing starts on capability add).
    readonly connectWithoutAutomations?: boolean;
    // Status cadence override (whatsapp: 5s).
    readonly statusMs?: number;
    // Writes .intentic/local/runtime/extensions/<provider>/gateway.url so the agent's CLI can find the control surface.
    readonly publishGatewayUrl?: boolean;
    readonly create: (ctx: GatewayCtx<TConfig>, control: GatewayControl) => GatewayHooks<TConfig, THandle>;
}

const requireEnv = (name: string, onMissing: () => void): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
        onMissing();
        process.exit(1);
    }
    return value;
};

const readBody = async (req: IncomingMessage): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
        chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
};

// Phase without a `phase` hook: idle if not holding, ready if a handle is held, connecting if an open is in
// flight.
const defaultPhase = <THandle>(view: SlotView<THandle>): ListenerGatewayPhase => {
    if (!view.holding) {
        return "idle";
    }
    if (view.handle !== undefined) {
        return "ready";
    }
    return view.connecting ? "connecting" : "disconnected";
};

export const runConnectorGateway = async <TConfig extends { readonly provider: string }, THandle>(
    spec: GatewaySpec<TConfig, THandle>,
): Promise<void> => {
    const log = createLog(spec.provider);
    const missing =
        (name: string): (() => void) =>
        () =>
            log.error({ name }, "missing required env: the gateway can't start");
    const daemonBase = requireEnv("INTENTIC_DAEMON", missing("INTENTIC_DAEMON"));
    const panelToken = requireEnv("INTENTIC_PANEL_TOKEN", missing("INTENTIC_PANEL_TOKEN"));
    const port = Number(requireEnv("PORT", missing("PORT")));
    const workspaceRoot = process.env["INTENTIC_WORKSPACE"] ?? WORKSPACE_ROOT;

    const daemon: DaemonClient<TConfig> = createDaemonClient(spec.provider, daemonBase, panelToken);

    // Which connection each slot holds, and the config key it was built from (to detect a token edit as a change).
    const wired = new Map<string, { key: string; handle: THandle }>();
    const connecting = new Set<string>();
    const fatalUntil = new Map<string, number>();

    const markFatal = (key: string, detail: string): void => {
        fatalUntil.set(key, Date.now() + FATAL_RETRY_MS);
        void daemon.failure(detail);
    };
    const hooks = spec.create({ daemon, workspaceRoot, log }, { markFatal });
    let connectors: ReadonlyArray<ConnectorEntry<TConfig>> = [];
    let holding = false;
    let anyDesired = false;

    const alive = hooks.alive ?? ((): boolean => true);

    const reconcile = async (): Promise<void> => {
        const state = await daemon.state().catch((error: unknown) => {
            log.error({ err: error }, "listener state fetch failed");
            return undefined;
        });
        if (state === undefined) {
            return;
        }
        connectors = state.connectors;
        // hooks.desired runs every tick even while not holding; the shell alone decides whether to keep the result.
        holding = spec.connectWithoutAutomations === true || state.automations.length > 0;
        const wanted = hooks.desired(connectors);
        const desired = new Map(holding ? wanted : []);
        anyDesired = desired.size > 0;
        // Deleting the current key during a Map iteration is safe (the iterator skips removed entries).
        for (const [slotId, slot] of wired) {
            const config = desired.get(slotId);
            const reason: CloseReason | undefined =
                config === undefined || hooks.keyOf(config) !== slot.key ? "superseded" : alive(slotId, slot.handle) ? undefined : "dead";
            if (reason !== undefined) {
                wired.delete(slotId);
                await hooks.close(slotId, slot.handle, reason);
            }
        }
        for (const [slotId, config] of desired) {
            const key = hooks.keyOf(config);
            if (wired.has(slotId) || connecting.has(slotId) || Date.now() < (fatalUntil.get(key) ?? 0)) {
                continue;
            }
            connecting.add(slotId);
            try {
                const handle = await hooks.open(slotId, config);
                fatalUntil.delete(key);
                wired.set(slotId, { key, handle });
            } catch (error) {
                log.error({ err: error, slotId }, "connect failed");
                const detail = hooks.fatal?.(error);
                if (detail !== undefined) {
                    markFatal(key, detail);
                }
            } finally {
                connecting.delete(slotId);
            }
        }
    };

    // Reconciles never overlap or reject; a poke mid-tick waits for the tick instead of racing a duplicate connect.
    let reconciling: Promise<void> = Promise.resolve();
    const reconcileNow = (): Promise<void> => {
        reconciling = reconciling.then(async () => {
            try {
                await reconcile();
            } catch (error) {
                log.error({ err: error }, "reconcile failed");
            }
        });
        return reconciling;
    };

    const postStatus = async (): Promise<void> => {
        const connections = connectors.map((connector) => {
            const slotId = (hooks.slotIdOf ?? ((entry: ConnectorEntry<TConfig>): string => entry.id))(connector);
            const slot = wired.get(slotId);
            const view: SlotView<THandle> = {
                holding,
                anyDesired,
                // A held-but-dead connection reads as absent, so the phase reports disconnected, not a doomed slot.
                handle: slot !== undefined && alive(slotId, slot.handle) ? slot.handle : undefined,
                connecting: connecting.has(slotId),
            };
            return {
                capabilityId: connector.id,
                provider: spec.provider,
                gateway: (hooks.phase ?? ((_: ConnectorEntry<TConfig>, each: SlotView<THandle>) => defaultPhase(each)))(connector, view),
            };
        });
        await daemon.status({ connections, ...hooks.statusExtras?.() });
    };

    // Loopback surface: /health always, plus the connector's control routes when it has a CLI; binds PORT.
    const server: Server = createServer((req, res) => {
        const send = (text: string, status = 200): void => {
            res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
            res.end(text);
        };
        void (async () => {
            try {
                const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
                if (req.method === "GET" && path === "/health") {
                    return send("ok");
                }
                // Daemon pokes this when an automation or capability changes; awaited, so it returns only once
                // connections match.
                if (req.method === "POST" && path === "/reconcile") {
                    await reconcileNow();
                    return send("ok");
                }
                // A failed deliver answers 502 with the provider's bare sentence, not the generic `error:`-prefixed
                // line.
                if (req.method === "POST" && path === "/deliver") {
                    if (hooks.deliver === undefined) {
                        return send(`the ${spec.provider} connector cannot post into a channel on its own`, 501);
                    }
                    const { channelId, text } = JSON.parse((await readBody(req)) || "{}") as { channelId?: unknown; text?: unknown };
                    if (typeof channelId !== "string" || channelId === "" || typeof text !== "string" || text === "") {
                        return send("channelId and text required", 400);
                    }
                    try {
                        await hooks.deliver(channelId, text);
                    } catch (error) {
                        if (!(error instanceof GatewayRefusal)) {
                            log.error({ err: error }, "delivery failed");
                        }
                        return send(deliveryErrorResponse(spec.provider, error), 502);
                    }
                    return send("ok");
                }
                const handled = await hooks.routes?.(req, () => readBody(req));
                if (handled !== undefined) {
                    return send(handled.body, handled.status ?? 200);
                }
                return send("not found", 404);
            } catch (error) {
                log.error({ err: error }, "control request failed");
                return send("internal gateway error", 500);
            }
        })();
    });

    // Publishes the control address for the agent's CLI to read.
    if (spec.publishGatewayUrl === true) {
        const urlFile = join(workspaceRoot, STATE_DIR, "local", "runtime", "extensions", spec.provider, "gateway.url");
        await mkdir(dirname(urlFile), { recursive: true });
        await writeFile(urlFile, `http://127.0.0.1:${port}`);
    }
    server.listen(port, "127.0.0.1", () => log.info({ port }, `${spec.provider} gateway listening`));

    const shutdown = (): void => {
        const wind = async (): Promise<void> => {
            if (hooks.shutdown !== undefined) {
                await hooks.shutdown(new Map([...wired].map(([slotId, slot]) => [slotId, slot.handle])));
            } else {
                await Promise.allSettled([...wired].map(([slotId, slot]) => hooks.close(slotId, slot.handle, "shutdown")));
            }
            wired.clear();
        };
        void Promise.race([wind(), sleep(SHUTDOWN_TIMEOUT_MS)]).finally(() => {
            server.close();
            process.exit(0);
        });
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // SIGHUP is also handled for a gateway still run under a pty, whose vanishing delivers this signal.
    process.on("SIGHUP", shutdown);

    await reconcileNow();
    setInterval(() => void reconcileNow(), RECONCILE_MS);
    await postStatus();
    setInterval(() => void postStatus(), spec.statusMs ?? STATUS_MS);
};
