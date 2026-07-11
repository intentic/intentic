import type { Observed, ProviderContext } from "@intentic/engine";
import { expect, test, vi } from "vitest";
import { createDiscordProvider } from "./discord.js";
import type { DiscordApi, DiscordChannel, DiscordGuild, DiscordWebhook } from "./discord-api.js";
import { CHANNEL_TYPE_CATEGORY, CHANNEL_TYPE_TEXT } from "./discord-api.js";

const BOT_TOKEN = "test-bot-token";
const ZONE = "example.com";
const GUILD_NAME = `intentic – ${ZONE}`;
const GUILD_ID = "guild-123";

const ctx: ProviderContext = { id: "discord", log: vi.fn(), env: {}, output: () => undefined };

const baseInputs = { botToken: BOT_TOKEN, zone: ZONE, apps: ["my-app"] };

// A fake DiscordApi that tracks created guilds/channels/webhooks.
const createFakeApi = (): {
    api: DiscordApi;
    guilds: DiscordGuild[];
    channels: DiscordChannel[];
    webhooks: DiscordWebhook[];
} => {
    const guilds: DiscordGuild[] = [];
    const channels: DiscordChannel[] = [];
    const webhooks: DiscordWebhook[] = [];
    let nextId = 1;

    const api: DiscordApi = {
        listGuilds: async () => guilds,
        createGuild: async (_token, name) => {
            const guild: DiscordGuild = { id: `guild-${nextId++}`, name, owner: true };
            guilds.push(guild);
            return guild;
        },
        getGuildChannels: async () => channels,
        createChannel: async (_token, _guildId, name, type, parentId) => {
            const channel: DiscordChannel = { id: `ch-${nextId++}`, name, type, parent_id: parentId };
            channels.push(channel);
            return channel;
        },
        getChannelWebhooks: async (_token, channelId) => webhooks.filter((wh) => wh.channel_id === channelId),
        createWebhook: async (_token, channelId, name) => {
            const webhook: DiscordWebhook = { id: `wh-${nextId++}`, name, channel_id: channelId, token: `tok-${nextId++}` };
            webhooks.push(webhook);
            return webhook;
        },
        executeWebhook: async () => {},
    };

    return { api, guilds, channels, webhooks };
};

test("read returns undefined when no matching guild exists", async () => {
    const { api } = createFakeApi();
    const provider = createDiscordProvider(api);
    const result = await provider.read(baseInputs, ctx);
    expect(result).toBeUndefined();
});

test("read returns observed state when guild + channels + webhooks exist", async () => {
    const { api, guilds, channels, webhooks } = createFakeApi();
    guilds.push({ id: GUILD_ID, name: GUILD_NAME, owner: true });
    const reconcileCh: DiscordChannel = { id: "ch-reconcile", name: "reconcile", type: CHANNEL_TYPE_TEXT, parent_id: undefined };
    const appCh: DiscordChannel = { id: "ch-app", name: "my-app", type: CHANNEL_TYPE_TEXT, parent_id: undefined };
    channels.push({ id: "cat-intentic", name: "intentic", type: CHANNEL_TYPE_CATEGORY, parent_id: undefined }, reconcileCh, appCh);
    webhooks.push(
        { id: "wh-reconcile", name: "intentic", channel_id: "ch-reconcile", token: "tok-r" },
        { id: "wh-app", name: "intentic", channel_id: "ch-app", token: "tok-a" },
    );

    const provider = createDiscordProvider(api);
    const result = await provider.read(baseInputs, ctx);

    expect(result).toBeDefined();
    expect(result!.outputs["guildId"]).toBe(GUILD_ID);
    expect(result!.outputs["reconcileWebhook"]).toBe("https://discord.com/api/webhooks/wh-reconcile/tok-r");
    expect(result!.outputs["appWebhook:my-app"]).toBe("https://discord.com/api/webhooks/wh-app/tok-a");
});

test("diff returns noop when all channels and webhooks exist", async () => {
    const provider = createDiscordProvider(createFakeApi().api);
    const observed: Observed = {
        outputs: { guildId: GUILD_ID },
        detail: {
            guildId: GUILD_ID,
            channelNames: ["reconcile", "my-app"],
            webhookNames: ["reconcile:intentic", "my-app:intentic"],
        },
    };
    const result = provider.diff(baseInputs, observed);
    expect(result.action).toBe("noop");
});

test("diff returns update when a channel is missing", async () => {
    const provider = createDiscordProvider(createFakeApi().api);
    const observed: Observed = {
        outputs: { guildId: GUILD_ID },
        detail: {
            guildId: GUILD_ID,
            channelNames: ["reconcile"],
            webhookNames: ["reconcile:intentic"],
        },
    };
    const result = provider.diff(baseInputs, observed);
    expect(result.action).toBe("update");
});

test("diff returns update when a webhook is missing", async () => {
    const provider = createDiscordProvider(createFakeApi().api);
    const observed: Observed = {
        outputs: { guildId: GUILD_ID },
        detail: {
            guildId: GUILD_ID,
            channelNames: ["reconcile", "my-app"],
            webhookNames: ["reconcile:intentic"],
        },
    };
    const result = provider.diff(baseInputs, observed);
    expect(result.action).toBe("update");
});

test("apply creates guild, categories, channels, and webhooks from scratch", async () => {
    const { api, guilds, channels, webhooks } = createFakeApi();
    const provider = createDiscordProvider(api);

    const outputs = await provider.apply!(baseInputs, undefined, ctx);

    // Guild was created.
    expect(guilds).toHaveLength(1);
    expect(guilds[0]!.name).toBe(GUILD_NAME);

    // Categories were created.
    const categories = channels.filter((ch) => ch.type === CHANNEL_TYPE_CATEGORY);
    expect(categories.map((c) => c.name).toSorted()).toEqual(["apps", "intentic"]);

    // Text channels were created.
    const textChannels = channels.filter((ch) => ch.type === CHANNEL_TYPE_TEXT);
    expect(textChannels.map((c) => c.name).toSorted()).toEqual(["my-app", "reconcile"]);

    // Webhooks were created for both channels.
    expect(webhooks).toHaveLength(2);
    expect(webhooks.every((wh) => wh.name === "intentic")).toBe(true);

    // Outputs contain the guild id, reconcile webhook, and per-app webhook.
    expect(outputs["guildId"]).toBe(guilds[0]!.id);
    expect(typeof outputs["reconcileWebhook"]).toBe("string");
    expect(typeof outputs["appWebhook:my-app"]).toBe("string");
});

test("apply reuses an existing guild instead of creating a new one", async () => {
    const { api, guilds, channels, webhooks } = createFakeApi();
    guilds.push({ id: GUILD_ID, name: GUILD_NAME, owner: true });
    const provider = createDiscordProvider(api);

    await provider.apply!(baseInputs, undefined, ctx);

    // No new guild was created — the existing one is reused.
    expect(guilds).toHaveLength(1);
    expect(guilds[0]!.id).toBe(GUILD_ID);

    // But channels and webhooks were still created.
    expect(channels.filter((ch) => ch.type === CHANNEL_TYPE_TEXT).length).toBeGreaterThanOrEqual(2);
    expect(webhooks.length).toBeGreaterThanOrEqual(2);
});
