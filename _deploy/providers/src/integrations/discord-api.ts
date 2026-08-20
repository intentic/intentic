import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { parseResponse } from "../core/inputs.js";

// A thin typed wrapper over the Discord REST API v10 (raw fetch, same pattern as komodo-api.ts /
// cloudflare-api.ts). Only the operations intentic needs: guild CRUD, channel CRUD, webhook CRUD,
// and posting messages to a webhook. Auth is a Bot token in the Authorization header.

const API_BASE = "https://discord.com/api/v10";

// Discord channel types (subset we use).
const CHANNEL_TYPE_TEXT = 0;
const CHANNEL_TYPE_CATEGORY = 4;

export interface DiscordGuild {
    readonly id: string;
    readonly name: string;
    readonly owner: boolean;
}

export interface DiscordChannel {
    readonly id: string;
    readonly name: string;
    readonly type: number;
    readonly parent_id: string | undefined;
}

export interface DiscordWebhook {
    readonly id: string;
    readonly name: string;
    readonly channel_id: string;
    readonly token: string;
}

// Zod schemas for validating Discord API responses.
const guildSchema = z.object({ id: z.string(), name: z.string(), owner: z.boolean().default(false) });
const channelSchema = z.object({ id: z.string(), name: z.string(), type: z.number(), parent_id: z.string().nullable().default(null) });
const webhookSchema = z.object({
    id: z.string(),
    name: z.string().nullable().default(""),
    channel_id: z.string(),
    token: z.string().nullable().default(""),
});

const headers = (botToken: string): Record<string, string> => ({
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
});

const MAX_RETRIES = 3;

// Discord is aggressive with rate limits (HTTP 429). The response body carries `retry_after` (seconds);
// we sleep that long and retry, up to MAX_RETRIES. All API methods go through this wrapper.
const discordFetch = async (url: string, init: RequestInit, label: string): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
        // Bound a stalled connection (undici's default headers timeout is ~5 minutes).
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
        if (response.status === 429 && attempt < MAX_RETRIES) {
            const body = (await response.json()) as { retry_after?: number };
            const ms = ((body.retry_after ?? 1) + 0.1) * 1000;
            await sleep(ms);
            continue;
        }
        if (!response.ok) {
            throw new Error(`Discord ${label} failed (HTTP ${response.status}): ${await response.text()}`);
        }
        return response;
    }
};

// The Discord API surface intentic uses, injectable for testing (same pattern as KomodoApi).
export interface DiscordApi {
    // GET /users/@me/guilds, list guilds the bot is a member of.
    readonly listGuilds: (botToken: string) => Promise<readonly DiscordGuild[]>;
    // POST /guilds, create a new guild (bot limit: 10 guilds).
    readonly createGuild: (botToken: string, name: string) => Promise<DiscordGuild>;
    // GET /guilds/{id}/channels, list all channels in a guild.
    readonly getGuildChannels: (botToken: string, guildId: string) => Promise<readonly DiscordChannel[]>;
    // POST /guilds/{id}/channels, create a channel (text or category).
    readonly createChannel: (botToken: string, guildId: string, name: string, type: number, parentId?: string) => Promise<DiscordChannel>;
    // GET /channels/{id}/webhooks, list webhooks on a channel.
    readonly getChannelWebhooks: (botToken: string, channelId: string) => Promise<readonly DiscordWebhook[]>;
    // POST /channels/{id}/webhooks, create a webhook on a channel.
    readonly createWebhook: (botToken: string, channelId: string, name: string) => Promise<DiscordWebhook>;
    // POST /webhooks/{id}/{token}, execute a webhook (no auth header needed). Used for posting
    // reconcile summaries.
    readonly executeWebhook: (webhookId: string, webhookToken: string, content: string) => Promise<void>;
}

export { CHANNEL_TYPE_CATEGORY, CHANNEL_TYPE_TEXT };

export const discordApi: DiscordApi = {
    listGuilds: async (botToken) => {
        const response = await discordFetch(`${API_BASE}/users/@me/guilds`, { headers: headers(botToken) }, "GET /users/@me/guilds");
        const items = z.array(guildSchema).parse(await response.json());
        return items.map((item): DiscordGuild => ({ id: item.id, name: item.name, owner: item.owner }));
    },
    createGuild: async (botToken, name) => {
        const response = await discordFetch(
            `${API_BASE}/guilds`,
            {
                method: "POST",
                headers: headers(botToken),
                body: JSON.stringify({ name }),
            },
            "POST /guilds",
        );
        return parseResponse(guildSchema, await response.json(), "POST /guilds");
    },
    getGuildChannels: async (botToken, guildId) => {
        const response = await discordFetch(
            `${API_BASE}/guilds/${guildId}/channels`,
            { headers: headers(botToken) },
            `GET /guilds/${guildId}/channels`,
        );
        const items = z.array(channelSchema).parse(await response.json());
        return items.map((item): DiscordChannel => ({ id: item.id, name: item.name, type: item.type, parent_id: item.parent_id ?? undefined }));
    },
    createChannel: async (botToken, guildId, name, type, parentId) => {
        const response = await discordFetch(
            `${API_BASE}/guilds/${guildId}/channels`,
            {
                method: "POST",
                headers: headers(botToken),
                body: JSON.stringify({ name, type, ...(parentId !== undefined ? { parent_id: parentId } : {}) }),
            },
            `POST /guilds/${guildId}/channels`,
        );
        const item = parseResponse(channelSchema, await response.json(), `POST /guilds/${guildId}/channels`);
        return { id: item.id, name: item.name, type: item.type, parent_id: item.parent_id ?? undefined };
    },
    getChannelWebhooks: async (botToken, channelId) => {
        const response = await discordFetch(
            `${API_BASE}/channels/${channelId}/webhooks`,
            { headers: headers(botToken) },
            `GET /channels/${channelId}/webhooks`,
        );
        const items = z.array(webhookSchema).parse(await response.json());
        return items.map((item): DiscordWebhook => ({ id: item.id, name: item.name ?? "", channel_id: item.channel_id, token: item.token ?? "" }));
    },
    createWebhook: async (botToken, channelId, name) => {
        const response = await discordFetch(
            `${API_BASE}/channels/${channelId}/webhooks`,
            {
                method: "POST",
                headers: headers(botToken),
                body: JSON.stringify({ name }),
            },
            `POST /channels/${channelId}/webhooks`,
        );
        const item = parseResponse(webhookSchema, await response.json(), `POST /channels/${channelId}/webhooks`);
        return { id: item.id, name: item.name ?? "", channel_id: item.channel_id, token: item.token ?? "" };
    },
    executeWebhook: async (webhookId, webhookToken, content) => {
        await discordFetch(
            `${API_BASE}/webhooks/${webhookId}/${webhookToken}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content }),
            },
            `POST /webhooks/${webhookId}/${webhookToken}`,
        );
    },
};
