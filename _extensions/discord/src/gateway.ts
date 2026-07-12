import { createServer, type IncomingMessage } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Client } from "discord.js";
import { whisperCliMissing } from "./audio.js";
import { discordGatewayState, ensureDiscordClient, releaseDiscordClient } from "./client.js";
import type { GatewayCtx } from "./context.js";
import { createDaemonClient, type DiscordConnectorConfig } from "./daemon.js";
import { createDiscordListener } from "./listener.js";
import { log } from "./log.js";
import { activeVoiceSession, joinVoice, leaveVoice, stopVoice, voiceStatus } from "./voice.js";

// The Discord gateway process: a baked extension's autoStart process (contributes.processes). It reconciles a
// discord.js connection per bot token against the daemon's /listeners/discord/state, dispatches every inbound
// message (painting mention replies back), holds voice sessions across turns, and exposes a loopback control
// surface the `discord-voice` CLI hits (join/leave/status). The daemon holds no Discord connection — this does.

// A fatal login (bad token / missing intent) pauses that token's reconnect this long; a portal-side fix must heal
// unattended, so it's not sticky forever.
const FATAL_RETRY_MS = 300_000;
const RECONCILE_MS = 30_000;
const STATUS_MS = 30_000;

const requireEnv = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") {
        log.error({ name }, "missing required env — the gateway can't start");
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

const main = async (): Promise<void> => {
    const daemonBase = requireEnv("INTENTIC_DAEMON");
    const panelToken = requireEnv("INTENTIC_PANEL_TOKEN");
    const port = Number(requireEnv("PORT"));
    const workspaceRoot = process.env["INTENTIC_WORKSPACE"] ?? "/work";

    const daemon = createDaemonClient(daemonBase, panelToken);
    const ctx: GatewayCtx = { daemon, workspaceRoot, log };

    // The reconcile-owned view of connected bots + the latest connectors (the voice control surface reads the
    // first connector's config; multi-bot voice is a ponytail).
    const subscribed = new Map<string, Client>();
    const fatalUntil = new Map<string, number>();
    let connectors: ReadonlyArray<{ id: string; config: DiscordConnectorConfig }> = [];
    const listener = createDiscordListener(ctx, subscribed);

    const reconcile = async (): Promise<void> => {
        const state = await daemon.state().catch((error: unknown) => {
            log.error({ err: error }, "listener state fetch failed");
            return undefined;
        });
        if (state === undefined) {
            return;
        }
        connectors = state.connectors;
        // Hold a connection only while an enabled discord listener automation exists (the state route already
        // filtered to those); no automations ⇒ release everything.
        const desired = new Set(state.automations.length === 0 ? [] : connectors.map((connector) => connector.config.botToken).filter((token) => token !== ""));
        for (const token of [...subscribed.keys()]) {
            if (!desired.has(token)) {
                subscribed.get(token)?.off("messageCreate", listener.onMessage);
                subscribed.delete(token);
                releaseDiscordClient(token, "listener");
            }
        }
        for (const token of desired) {
            if (subscribed.has(token) || Date.now() < (fatalUntil.get(token) ?? 0)) {
                continue;
            }
            try {
                const client = await ensureDiscordClient(token, "listener");
                fatalUntil.delete(token);
                subscribed.set(token, client);
                client.on("messageCreate", listener.onMessage);
            } catch (error) {
                fatalUntil.set(token, Date.now() + FATAL_RETRY_MS);
                releaseDiscordClient(token, "listener");
                const detail = error instanceof Error ? error.message : String(error);
                log.error({ err: error }, "discord listener login failed");
                await daemon.failure(detail);
            }
        }
    };

    // whisper presence can't change without an image rebuild (which restarts this process), so probe once.
    let whisperReady = false;
    void whisperCliMissing().then((missing) => {
        whisperReady = !missing;
    });

    const postStatus = async (): Promise<void> => {
        const connections = connectors.map((connector) => ({
            capabilityId: connector.id,
            provider: "discord",
            gateway: discordGatewayState(connector.config.botToken),
        }));
        const voice = activeVoiceSession();
        await daemon.status({ connections, ...(voice !== undefined ? { voice } : {}), whisperReady });
    };

    // The loopback control surface for the `discord-voice` CLI. Loopback + same-container only; the bot token the
    // CLI would need to talk to Discord itself is already in the agent's env, so no extra auth here.
    const voiceConfig = (): DiscordConnectorConfig | undefined => connectors[0]?.config;
    const server = createServer((req, res) => {
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
                if (path === "/voice/status") {
                    return send(voiceStatus());
                }
                if (req.method === "POST" && path === "/voice/leave") {
                    return send(await leaveVoice());
                }
                if (req.method === "POST" && path === "/voice/join") {
                    const channelId = String((JSON.parse((await readBody(req)) || "{}") as { channelId?: unknown }).channelId ?? "");
                    if (channelId === "") {
                        return send("channelId required", 400);
                    }
                    const config = voiceConfig();
                    return send(config === undefined ? "No Discord bot is connected — add the Discord capability first." : await joinVoice(ctx, channelId, config));
                }
                return send("not found", 404);
            } catch (error) {
                log.error({ err: error }, "control request failed");
                return send(`error: ${error instanceof Error ? error.message : String(error)}`, 500);
            }
        })();
    });

    // Publish the control address for the CLI to read (the daemon injects nothing Discord-specific into the agent).
    const urlFile = join(workspaceRoot, ".intentic", "extensions-runtime", "discord", "gateway.url");
    await mkdir(dirname(urlFile), { recursive: true });
    await writeFile(urlFile, `http://127.0.0.1:${port}`);

    server.listen(port, "127.0.0.1", () => log.info({ port }, "discord gateway control surface listening"));

    const shutdown = (): void => {
        void stopVoice().finally(() => {
            server.close();
            process.exit(0);
        });
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);

    await reconcile();
    setInterval(() => void reconcile(), RECONCILE_MS);
    await postStatus();
    setInterval(() => void postStatus(), STATUS_MS);
};

void main();
