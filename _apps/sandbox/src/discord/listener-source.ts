import type { Capability } from "@intentic/sandbox-contract";
import type { Client, Message } from "discord.js";
import { streamAgent } from "../agent/agent.routes.js";
import {
    DEBOUNCE_MS,
    dispatchListenerMessage,
    FATAL_RETRY_MS,
    type ListenerMessage,
    type ListenerSource,
    type ListenerState,
    reportListenerFailure,
} from "../automations/listeners.js";
import type { Services } from "../composition.js";
import type { WakeFn } from "../automations/scheduler.js";
import { ensureDiscordClient, releaseDiscordClient } from "./client.js";
import { createDiscordStream } from "./discord-stream.js";

// The Discord realtime source: while an enabled discord listener automation exists, hold a gateway client per
// connected discord bot token and dispatch every human-authored message. Instant replacement for the old
// "check every 5 min" poll recipe. Multiple bots (multiple discord capabilities) run concurrently.

export const discordBotTokens = (capabilities: readonly Capability[]): Set<string> => {
    const tokens = new Set<string>();
    for (const capability of capabilities) {
        if (capability.kind === "cli" && capability.config.provider === "discord") {
            tokens.add(capability.config["botToken"] ?? "");
        }
    }
    return tokens;
};

// Recent message ids, to drop the duplicate delivery when two of our bots share a channel and both receive the
// same human message. ponytail: best-effort in-memory cap; a restart forgets it — at worst one duplicate wake.
const RECENT_MAX = 500;

// Prior messages pulled for context when a bot is tagged (discord fetch max is 100).
const HISTORY_LIMIT = 20;

// Discord's typing indicator auto-expires after ~10s; re-send on this cadence so the bot shows
// "typing…" for the whole turn. Capped so a turn that never replies can't leak the interval forever.
const TYPING_INTERVAL_MS = 8_000;
const TYPING_MAX_MS = 300_000;

// Newest-first discord messages (as fetch returns them) → chronological history entries, flagging posts by our
// own bots so the model recognizes its prior replies. Exported for tests.
export const toHistory = (newestFirst: readonly Message[], selfIds: ReadonlySet<string>): ListenerMessage["history"] =>
    [...newestFirst].reverse().map((m) => ({
        author: { id: m.author.id, name: m.author.username },
        content: m.content,
        timestamp: m.createdAt.toISOString(),
        ...(selfIds.has(m.author.id) ? { self: true } : {}),
    }));

export const createDiscordSource = (services: Services, wake: WakeFn = streamAgent): ListenerSource => {
    const subscribed = new Map<string, Client>();
    const fatalUntil = new Map<string, number>();
    const recent = new Set<string>();
    // Live "typing…" indicators keyed by channelId — started on a mention, cleared when our own reply
    // lands (see onMessage's own-bot branch) or after TYPING_MAX_MS.
    const typing = new Map<string, NodeJS.Timeout>();
    const stopTyping = (channelId: string): void => {
        const timer = typing.get(channelId);
        if (timer !== undefined) {
            clearInterval(timer);
            typing.delete(channelId);
        }
    };
    const startTyping = (channel: Message["channel"]): void => {
        if (!("sendTyping" in channel)) {
            return;
        }
        stopTyping(channel.id);
        void channel.sendTyping().catch(() => undefined);
        const startedAt = Date.now();
        typing.set(
            channel.id,
            setInterval(() => {
                if (Date.now() - startedAt > TYPING_MAX_MS) {
                    stopTyping(channel.id);
                    return;
                }
                void channel.sendTyping().catch(() => undefined);
            }, TYPING_INTERVAL_MS),
        );
    };

    const fetchHistory = async (message: Message): Promise<ListenerMessage["history"]> => {
        const fetched = await message.channel.messages.fetch({ limit: HISTORY_LIMIT, before: message.id });
        const selfIds = new Set([...subscribed.values()].flatMap((c) => (c.user !== null ? [c.user.id] : [])));
        return toHistory([...fetched.values()], selfIds);
    };

    const onMessage = (message: Message): void => {
        // Never wake on our own bots' posts (any connected instance) — an agent reply in-channel must not
        // re-trigger, and bot A must not wake on bot B. Third-party bots/webhooks still dispatch (CI alerts are
        // a valid trigger); guards can filter them.
        for (const client of subscribed.values()) {
            if (client.user?.id === message.author.id) {
                // Our own reply landed in this channel — stop the "typing…" heartbeat.
                stopTyping(message.channelId);
                return;
            }
        }
        if (recent.has(message.id)) {
            return;
        }
        recent.add(message.id);
        if (recent.size > RECENT_MAX) {
            const oldest = recent.values().next().value;
            if (oldest !== undefined) {
                recent.delete(oldest);
            }
        }
        // "Tagged": a direct @mention of any of our bots or a reply to one of their messages (roles/@everyone
        // excluded) — checked against every subscribed bot because the recent-id dedup means only the first
        // delivery dispatches, and it may reach a bot other than the one tagged.
        const mentioned = [...subscribed.values()].some(
            (client) => client.user !== null && message.mentions.has(client.user, { ignoreEveryone: true, ignoreRoles: true }),
        );
        if (mentioned) {
            // Immediate feedback: show "typing…" the moment we're tagged, before the (debounced) turn even
            // spins up — otherwise the bot is silent through the whole cold-start + inference.
            startTyping(message.channel);
        }
        // Stream a mention reply back into this channel live (created per matched automation in dispatch). Only
        // when we can post here; otherwise the agent sends its own reply via the Discord skill, as before. The
        // channel is captured as a const so the `"send" in` narrowing survives into the closure.
        const channel = message.channel;
        const makeStream =
            mentioned && "send" in channel
                ? () => createDiscordStream(channel, (error: unknown) => services.logger.warn({ err: error }, "discord stream failed"))
                : undefined;
        // ponytail: a tagged message in a burst carries its own overlapping history; minor payload waste, not
        // worth deduping across the batch.
        void (async () => {
            const history = mentioned
                ? await fetchHistory(message).catch((error: unknown) => {
                      // A history-fetch failure (missing Read Message History perm, rate limit) must not drop
                      // the wake — degrade to no context.
                      services.logger.warn({ err: error }, "discord history fetch failed");
                      return undefined;
                  })
                : undefined;
            await dispatchListenerMessage(
                services,
                {
                    provider: "discord",
                    type: "message",
                    id: message.id,
                    channelId: message.channelId,
                    author: { id: message.author.id, name: message.author.username },
                    content: message.content,
                    ...(mentioned ? { mentioned: true } : {}),
                    ...(history !== undefined && history.length > 0 ? { history } : {}),
                    timestamp: message.createdAt.toISOString(),
                    extra: {
                        ...(message.guildId !== null ? { guildId: message.guildId } : {}),
                        ...(message.attachments.size > 0 ? { attachments: message.attachments.map(({ name, url }) => ({ name, url })) } : {}),
                    },
                },
                wake,
                DEBOUNCE_MS,
                makeStream,
            );
        })().catch((error: unknown) => services.logger.error({ err: error }, "discord message dispatch failed"));
    };

    const release = (token: string): void => {
        subscribed.get(token)?.off("messageCreate", onMessage);
        subscribed.delete(token);
        releaseDiscordClient(token, "listener");
    };

    const ensure = async ({ automations, capabilities }: ListenerState): Promise<void> => {
        const desired = automations.length === 0 ? new Set<string>() : discordBotTokens(capabilities);
        for (const token of subscribed.keys()) {
            if (!desired.has(token)) {
                release(token);
            }
        }
        for (const token of desired) {
            if (subscribed.has(token) || Date.now() < (fatalUntil.get(token) ?? 0)) {
                continue;
            }
            let client: Client;
            try {
                client = await ensureDiscordClient(token, "listener");
            } catch (error) {
                fatalUntil.set(token, Date.now() + FATAL_RETRY_MS);
                releaseDiscordClient(token, "listener");
                const detail = error instanceof Error ? error.message : String(error);
                services.logger.error({ err: error }, "discord listener login failed");
                await reportListenerFailure(services, "discord", detail);
                continue;
            }
            fatalUntil.delete(token);
            subscribed.set(token, client);
            client.on("messageCreate", onMessage);
        }
    };

    return {
        provider: "discord",
        ensure,
        stop: () => {
            for (const channelId of [...typing.keys()]) {
                stopTyping(channelId);
            }
            for (const token of subscribed.keys()) {
                release(token);
            }
        },
    };
};
