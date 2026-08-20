import { Client, GatewayIntentBits, Partials } from "discord.js";

export interface DiscordConnectorConfig {
    readonly provider: string;
    readonly botToken: string;
    readonly voiceModel?: string;
    readonly voiceLanguage?: string;
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

// Map discord.js login rejections onto messages a user can act on. Both are FATAL: retrying with the same
// token/portal state can never succeed.
const loginFailure = (error: unknown): Error => {
    const message = error instanceof Error ? error.message : String(error);
    if (/token/i.test(message)) {
        return new Error("Discord rejected the bot token — check the capability's botToken");
    }
    if (/intent/i.test(message)) {
        return new Error("Discord refused the gateway intents — enable the Message Content privileged intent (Developer Portal → Bot)");
    }
    return error instanceof Error ? error : new Error(message);
};
