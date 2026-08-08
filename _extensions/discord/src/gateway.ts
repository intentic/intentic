import { type GatewayHooks, runConnectorGateway } from "@intentic/connector-runtime";
import type { Client } from "discord.js";
import { whisperCliMissing } from "./audio.js";
import { type DiscordConnectorConfig, discordGatewayState, ensureDiscordClient, releaseDiscordClient } from "./client.js";
import { createDiscordListener } from "./listener.js";
import { activeVoiceSession, joinVoice, leaveVoice, stopVoice, voiceStatus } from "./voice.js";

// The Discord gateway process: a baked extension's autoStart process (contributes.processes). It reconciles a
// discord.js connection per bot token against the daemon's /listeners/discord/state, dispatches every inbound
// message (painting mention replies back), holds voice sessions across turns, and exposes a loopback control
// surface the `discord-voice` CLI hits (join/leave/status). The daemon holds no Discord connection — this does.
// The reconcile/status/health/shutdown shell is the shared connector runtime; what's here is only what Discord
// IS: a refcounted client per bot token (shared with voice), a login failure that retrying can't fix, and the
// voice control routes.

void runConnectorGateway<DiscordConnectorConfig, Client>({
    provider: "discord",
    publishGatewayUrl: true,
    create: (ctx) => {
        // The listener's live view of connected bots — maintained by open/close below. Keyed by TOKEN, which is
        // also the slot key: two capabilities sharing one bot token share one client and one subscription.
        const subscribed = new Map<string, Client>();
        const listener = createDiscordListener(ctx, subscribed);
        // The voice control surface reads the first connector's config; multi-bot voice is a ponytail.
        let connectors: ReadonlyArray<{ id: string; config: DiscordConnectorConfig }> = [];

        // whisper presence can't change without an image rebuild (which restarts this process), so probe once.
        let whisperReady = false;
        void whisperCliMissing().then((missing) => {
            whisperReady = !missing;
        });

        const hooks: GatewayHooks<DiscordConnectorConfig, Client> = {
            desired: (entries) => {
                connectors = entries;
                return entries.filter(({ config }) => config.botToken !== "").map(({ config }) => [config.botToken, config] as const);
            },
            keyOf: (config) => config.botToken,
            slotIdOf: (connector) => connector.config.botToken,
            open: async (token) => {
                try {
                    const client = await ensureDiscordClient(token, "listener");
                    subscribed.set(token, client);
                    client.on("messageCreate", listener.onMessage);
                    return client;
                } catch (error) {
                    releaseDiscordClient(token, "listener");
                    throw error;
                }
            },
            close: (token, client) => {
                client.off("messageCreate", listener.onMessage);
                subscribed.delete(token);
                releaseDiscordClient(token, "listener");
            },
            // Every login failure is fatal — a bad token or missing intent can only be fixed portal-side, and
            // client.ts has already mapped it onto a sentence the owner can act on.
            fatal: (error) => (error instanceof Error ? error.message : String(error)),
            phase: (connector) => discordGatewayState(connector.config.botToken),
            statusExtras: () => {
                const voice = activeVoiceSession();
                return { ...(voice !== undefined ? { voice } : {}), whisperReady };
            },
            // The loopback control surface for the `discord-voice` CLI. Loopback + same-container only; the bot
            // token the CLI would need to talk to Discord itself is already in the agent's env, so no extra auth.
            routes: async (req, body) => {
                const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
                if (path === "/voice/status") {
                    return { body: voiceStatus() };
                }
                if (req.method === "POST" && path === "/voice/leave") {
                    return { body: await leaveVoice() };
                }
                if (req.method === "POST" && path === "/voice/join") {
                    const channelId = String((JSON.parse((await body()) || "{}") as { channelId?: unknown }).channelId ?? "");
                    if (channelId === "") {
                        return { status: 400, body: "channelId required" };
                    }
                    const config = connectors[0]?.config;
                    return {
                        body:
                            config === undefined
                                ? "No Discord bot is connected — add the Discord capability first."
                                : await joinVoice(ctx, channelId, config),
                    };
                }
                return undefined;
            },
            // Clients die with the process; only the voice session needs an orderly goodbye.
            shutdown: () => stopVoice(),
        };
        return hooks;
    },
});
