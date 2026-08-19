import { createServer, type IncomingMessage, type Server } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import type { ListenerGatewayPhase, ListenerStatus } from "@intentic/sandbox-contract";
import { type DaemonClient, createDaemonClient } from "./daemon.js";
import type { GatewayCtx } from "./context.js";
import { createLog } from "./log.js";

/* The connector gateway shell: a baked extension's autoStart process (contributes.processes). It reconciles the
 * provider connections a connector module opens against the daemon's /listeners/<provider>/state, reports
 * liveness on a status cadence, serves a loopback /health (plus the connector's own control routes when it has
 * a CLI to serve), and dies cleanly on SIGTERM/SIGINT/SIGHUP. The daemon holds no provider connection — the
 * gateway process does.
 *
 * This loop existed five times, once per connector, identical except for the provider name and the connect
 * verbs; the per-provider truth now lives in a GatewayConnector spec (what a connection IS, how to open and
 * close one, when a failure is fatal) and everything else is written once here. */

// A fatal connect (revoked token, missing intent, webhook conflict) pauses that connection's reconnect this
// long; a portal-side fix must heal unattended, so it's not sticky forever.
const FATAL_RETRY_MS = 300_000;
const RECONCILE_MS = 30_000;
const STATUS_MS = 30_000;
// A wedged close must not hold shutdown hostage — the daemon's stop is `tmux kill-session`.
const SHUTDOWN_TIMEOUT_MS = 3_000;

export interface ConnectorEntry<TConfig> {
    readonly id: string;
    readonly config: TConfig;
}

// What the shell knows about one slot when a connector computes its status phase or drop decision.
export interface SlotView<THandle> {
    // Whether the gateway should be holding connections at all (an enabled listener automation exists, or the
    // connector opted into connecting regardless).
    readonly holding: boolean;
    // Whether ANY connection is desired right now (whatsapp's idle predicate — no connector has a phone yet).
    readonly anyDesired: boolean;
    readonly handle: THandle | undefined;
    readonly connecting: boolean;
}

export type CloseReason = "superseded" | "dead" | "shutdown";

// A connector may decline a delivery with a sentence deliberately written for the owner. Everything else is
// an internal/provider exception: its message or stack belongs in the gateway log, never in the HTTP response.
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

// The per-provider half of a gateway, returned by the spec's create(ctx) so it can close over the listener and
// connection pool it builds from the ctx.
export interface GatewayHooks<TConfig, THandle> {
    // slot id → config for every connection that should exist, configs already filtered complete (an empty
    // token is not a connection to want). Keyed by capability id for most connectors; discord keys by bot
    // token, which deduplicates two capabilities sharing one bot.
    readonly desired: (connectors: ReadonlyArray<ConnectorEntry<TConfig>>) => ReadonlyArray<readonly [string, TConfig]>;
    // The connection's identity: a config edit that changes it must reconnect (slack: both tokens — a bot-token
    // rotation must reconnect even though the app token is unchanged). Also the fatal-backoff key.
    readonly keyOf: (config: TConfig) => string;
    readonly open: (slotId: string, config: TConfig) => Promise<THandle>;
    readonly close: (slotId: string, handle: THandle, reason: CloseReason) => void | Promise<void>;
    // Whether a held connection is still good. A poll loop that hit a fatal error takes itself out of the
    // provider pool; reporting it dead here is what lets the loop reopen it, instead of trusting a slot forever.
    readonly alive?: (slotId: string, handle: THandle) => boolean;
    // A failure that retrying with the same config can never fix, mapped to the sentence the owner should see;
    // undefined = transient, retry next tick with no backoff.
    readonly fatal?: (error: unknown) => string | undefined;
    // The slot a connector capability's status row reads (default: its own id; discord: its bot token).
    readonly slotIdOf?: (connector: ConnectorEntry<TConfig>) => string;
    // Override the derived phase when the provider knows better (discord probes its client pool; whatsapp is
    // "connecting" the whole time a session is pairing).
    readonly phase?: (connector: ConnectorEntry<TConfig>, view: SlotView<THandle>) => ListenerGatewayPhase;
    // Per-gateway extras that ride the status snapshot: discord's voice session + whisper presence, whatsapp's
    // pairing codes.
    readonly statusExtras?: () => Omit<ListenerStatus, "connections">;
    /* Deliver one outbound message into a provider channel OUTSIDE any live turn stream — the daemon's
     * "speak as the agent" door (POST /deliver, served by the shell). The turn painters above only exist while
     * a dispatch response is held open; a message the OWNER places in a channel conversation between turns has
     * no such stream, so the daemon knocks here instead. `channelId` arrives exactly as the connector's own
     * listener reported it (a Discord channel id, a Slack channel, a Telegram chat id, a WhatsApp JID).
     * Throwing reports the provider's own sentence back to the daemon; absent, the shell answers 501 and the
     * daemon tells the owner this provider cannot carry a placed message. */
    readonly deliver?: (channelId: string, text: string) => Promise<void>;
    // The connector's loopback control surface (discord-voice, the whatsapp CLI). Return undefined for an
    // unmatched route; throwing reports a 500 with the error's message. /health is the shell's.
    readonly routes?: (req: IncomingMessage, body: () => Promise<string>) => Promise<{ status?: number; body: string } | undefined>;
    // Replaces the default shutdown (close every held connection): discord only stops voice — its clients die
    // with the process — and connectors with listeners retire their timers here too.
    readonly shutdown?: (wired: ReadonlyMap<string, THandle>) => void | Promise<void>;
}

// Shell-owned levers a connector's callbacks can pull mid-life: a poll loop that dies AFTER a successful open
// (telegram's long-poll refusing a token that was fine at connect) reports the same fatal backoff an open
// failure would, so the next reconcile doesn't hammer a dead credential.
export interface GatewayControl {
    readonly markFatal: (key: string, detail: string) => void;
}

export interface GatewaySpec<TConfig extends { readonly provider: string }, THandle> {
    readonly provider: string;
    // Hold connections while a CONNECTOR exists, automations or not (whatsapp: pairing starts the moment the
    // capability is added, the agent's CLI sends through this socket, and a session left offline for weeks gets
    // unlinked). Everyone else connects only while an enabled listener automation exists.
    readonly connectWithoutAutomations?: boolean;
    // Status cadence override (whatsapp: 5s — a fresh pairing code must not wait half a minute).
    readonly statusMs?: number;
    // Write .intentic/local/runtime/extensions/<provider>/gateway.url so the agent's CLI can find the control surface
    // (the daemon injects nothing provider-specific into the agent's environment).
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

// The phase a connector gets without a `phase` hook: idle while holding nothing on purpose, ready while a live
// handle is held, connecting while an open is in flight.
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
            log.error({ name }, "missing required env — the gateway can't start");
    const daemonBase = requireEnv("INTENTIC_DAEMON", missing("INTENTIC_DAEMON"));
    const panelToken = requireEnv("INTENTIC_PANEL_TOKEN", missing("INTENTIC_PANEL_TOKEN"));
    const port = Number(requireEnv("PORT", missing("PORT")));
    const workspaceRoot = process.env["INTENTIC_WORKSPACE"] ?? WORKSPACE_ROOT;

    const daemon: DaemonClient<TConfig> = createDaemonClient(spec.provider, daemonBase, panelToken);

    // The reconcile-owned view: which connection each slot currently holds, and the config key it was built
    // from (so a token edit is seen as a change rather than as "already connected").
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
        // Hold connections only while an enabled listener automation exists (the state route already filtered
        // to those); no automations ⇒ release everything — unless the connector opted out of that predicate.
        // hooks.desired runs EVERY tick (not just while holding): connectors keep their side of the world
        // current from it (discord's voice routes read the latest configs), and the shell gates the result.
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

    /* Reconciles never overlap and never reject. The loop below and the daemon's poke share one tail, so a poke
     * landing mid-tick waits for that tick instead of racing it into a second connection for one slot. */
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
                // A held-but-dead connection reads as absent, so the derived phase says "disconnected" rather
                // than trusting a slot the next reconcile is about to drop.
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

    // Loopback surface: /health always (so the operator can `curl` a suspect process), plus the connector's
    // control routes when it has a CLI to serve. Binds the panel manager's assigned PORT.
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
                /* "Re-read /state now" — the daemon pokes this the moment a listener automation or a connector
                 * capability changes. Without it, switching an integration ON left the bot deaf until the poll
                 * below came round: a message sent in that window was never seen at all, which reads as the
                 * integration being broken rather than as it not being up yet. Awaited, so the daemon's call
                 * returns only once the connections match. */
                if (req.method === "POST" && path === "/reconcile") {
                    await reconcileNow();
                    return send("ok");
                }
                /* The daemon's outbound door (see GatewayHooks.deliver): a message placed in a channel
                 * conversation between turns, carried into the channel through the connection this process
                 * holds. A deliver that fails answers 502 with the provider's BARE sentence — the daemon shows
                 * that body to the owner instead of placing the message, so it must read as words, not as the
                 * generic catch's `error:`-prefixed line. */
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

    // Publish the control address for the agent's CLI to read (the discord-voice pattern).
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
        void Promise.race([wind(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]).finally(() => {
            server.close();
            process.exit(0);
        });
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    // A managed stop is `tmux kill-session`, which delivers SIGHUP (the pty vanishing), not SIGTERM.
    process.on("SIGHUP", shutdown);

    await reconcileNow();
    setInterval(() => void reconcileNow(), RECONCILE_MS);
    await postStatus();
    setInterval(() => void postStatus(), spec.statusMs ?? STATUS_MS);
};
