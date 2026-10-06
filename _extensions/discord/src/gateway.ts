import { errorMessage } from "@intentic/base/errors";
import { whisperCliMissing } from "@intentic/base/whisper";
import { type GatewayHooks, runConnectorGateway } from "@intentic/connector-runtime";
import { type Client, REST } from "discord.js";
import { type DiscordConnectorConfig, discordGatewayState, ensureDiscordClient, releaseDiscordClient } from "./client.js";
import { type ChannelLookup, clientLookup, createDiscordListener, deliverToChannel, restLookup } from "./listener.js";
import { activeVoiceSession, joinVoice, leaveVoice, stopVoice, voiceStatus } from "./voice.js";

// Discord gateway: a baked extension's autoStart process. Reconciles a discord.js connection per bot token, dispatches
// messages, holds voice sessions, and exposes the loopback surface `discord-voice` hits; the daemon holds no Discord
// connection itself. The connector runtime shares reconcile/status/shutdown; this file is only what's Discord-specific.

void runConnectorGateway<DiscordConnectorConfig, Client>({
    provider: "discord",
    publishGatewayUrl: true,
    create: (ctx) => {
        // Listener's live view of connected bots, keyed by token; two capabilities sharing a token share one client.
        const subscribed = new Map<string, Client>();
        const listener = createDiscordListener(ctx, subscribed);
        // The voice control surface reads the first connector's config; multi-bot voice is a ponytail.
        let connectors: ReadonlyArray<{ id: string; config: DiscordConnectorConfig }> = [];
        // One REST handle per bot token, for a delivery while no client is connected (no automation holds one), made
        // on first use and kept: each carries its own rate-limit buckets.
        const rests = new Map<string, REST>();
        const restOf = (token: string): REST => {
            const existing = rests.get(token) ?? new REST({ version: "10" }).setToken(token);
            rests.set(token, existing);
            return existing;
        };
        // The connected clients when there are any; else every configured token over REST, so an owner-approved post
        // reaches Discord without the gateway opening (and then holding) a socket nobody else needs.
        const deliveringBots = (): ChannelLookup[] => {
            if (subscribed.size > 0) {
                return [...subscribed.values()].map(clientLookup);
            }
            const tokens = new Set(connectors.map(({ config }) => config.botToken).filter((token) => token !== ""));
            return [...tokens].map((token) => restLookup(restOf(token)));
        };

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
            // Every login failure is fatal; only fixable portal-side, and client.ts already phrases it actionably.
            fatal: (error) => errorMessage(error),
            phase: (connector) => discordGatewayState(connector.config.botToken),
            statusExtras: () => {
                const voice = activeVoiceSession();
                return { ...(voice !== undefined ? { voice } : {}), whisperReady };
            },
            // Daemon's outbound door (a conversation's reply between turns, an approved post): posts through whichever
            // bot can see the channel.
            deliver: (channelId, text) => deliverToChannel(deliveringBots(), channelId, text),
            // Loopback control surface for the discord-voice CLI; same-container only, so no extra auth beyond that.
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
                                ? "No Discord bot is connected: add the Discord capability first."
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
