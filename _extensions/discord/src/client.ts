import { errorMessage } from "@intentic/base/errors";
import { type Channel, Client, DiscordAPIError, DiscordjsError, DiscordjsErrorCodes, GatewayIntentBits, Partials } from "discord.js";

export interface DiscordConnectorConfig {
    readonly provider: string;
    readonly botToken: string;
    readonly voiceLanguage?: string;
    // How much of the agent's work a thread's status card shows: "steps" (the default), "quiet" or "off".
    readonly progress?: string;
}

// The gateway's discord.js clients, one connection per bot token, shared by the text listener and the voice
// session manager, each alive only while at least one consumer needs it. A module singleton map: both consumers
// reach it directly. discord.js owns resume/backoff for a live session; a failed login clears that token's slot
// so the next reconcile tick retries.

type Consumer = "listener" | "voice";

interface Slot {
    readonly client: Client;
    readonly ready: Promise<Client>;
    readonly consumers: Set<Consumer>;
}

const slots = new Map<string, Slot>();

export const ensureDiscordClient = (token: string, consumer: Consumer): Promise<Client> => {
    const existing = slots.get(token);
    if (existing !== undefined) {
        existing.consumers.add(consumer);
        return existing.ready;
    }
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.DirectMessages,
        ],
        // DM channels arrive partial (no cache warm-up event), without this, DM messageCreate is dropped.
        partials: [Partials.Channel],
    });
    const slot: Slot = {
        client,
        consumers: new Set([consumer]),
        ready: client.login(token).then(
            () => client,
            (error: unknown) => {
                void client.destroy();
                if (slots.get(token) === slot) {
                    slots.delete(token);
                }
                throw loginFailure(error);
            },
        ),
    };
    slots.set(token, slot);
    return slot.ready;
};

// The channel as this bot sees it, or null when Discord answers that the id names nothing this bot can see. Any other
// failure (an outage, a rate limit) throws, since it says nothing about what the bot may see.
export const visibleChannel = (client: Client, channelId: string): Promise<Channel | null> =>
    client.channels.fetch(channelId).catch((error: unknown) => {
        if (error instanceof DiscordAPIError && (error.status === 400 || error.status === 403 || error.status === 404)) {
            return null;
        }
        throw error;
    });

// Live gateway state for the status snapshot, a probe over the pool, no event plumbing.
export const discordGatewayState = (token: string): "ready" | "connecting" | "disconnected" => {
    const slot = slots.get(token);
    if (slot === undefined) {
        return "disconnected";
    }
    return slot.client.isReady() ? "ready" : "connecting";
};

export const releaseDiscordClient = (token: string, consumer: Consumer): void => {
    const slot = slots.get(token);
    if (slot === undefined) {
        return;
    }
    slot.consumers.delete(consumer);
    if (slot.consumers.size > 0) {
        return;
    }
    void slot.client.destroy();
    slots.delete(token);
};

// The gateway closing on a token (4004) or on a privileged intent (4014) reaches login as @discordjs/ws's plain Error,
// with no code and no close code on it, so only its words say which.
// allow(dependency-text): @discordjs/ws; any other wording is passed on as it came, still fatal.
const gatewayRefused = (message: string, refusal: "token" | "intents"): boolean =>
    refusal === "token" ? /^Authentication failed$/.test(message) : /disallowed intents/i.test(message);

// Map discord.js login rejections onto messages a user can act on. Both are FATAL: retrying with the same
// token/portal state can never succeed. A token REST refuses (401) is discord.js's own coded error.
const loginFailure = (error: unknown): Error => {
    const message = errorMessage(error);
    const code = error instanceof DiscordjsError ? error.code : undefined;
    if (code === DiscordjsErrorCodes.TokenInvalid || gatewayRefused(message, "token")) {
        return new Error("Discord rejected the bot token: check the capability's botToken");
    }
    if (code === DiscordjsErrorCodes.DisallowedIntents || gatewayRefused(message, "intents")) {
        return new Error("Discord refused the gateway intents: enable the Message Content privileged intent (Developer Portal → Bot)");
    }
    return error instanceof Error ? error : new Error(message);
};
