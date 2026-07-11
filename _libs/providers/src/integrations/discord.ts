import type { Provider, ResolvedInputs } from "@intentic/engine";
import { z } from "zod";
import { parseInputs } from "../core/inputs.js";
import type { DiscordApi, DiscordChannel, DiscordWebhook } from "./discord-api.js";
import { CHANNEL_TYPE_CATEGORY, CHANNEL_TYPE_TEXT, discordApi } from "./discord-api.js";

const discordSchema = z.object({
    botToken: z.string(),
    zone: z.string(),
    apps: z.array(z.string()),
});
type DiscordInputs = z.infer<typeof discordSchema>;
const parse = (inputs: ResolvedInputs): DiscordInputs => parseInputs(discordSchema, inputs, "discord");

const WEBHOOK_NAME = "intentic";
const guildName = (zone: string): string => `intentic – ${zone}`;

// The category/channel layout intentic owns inside the guild.
const CATEGORY_INTENTIC = "intentic";
const CATEGORY_APPS = "apps";
const CHANNEL_RECONCILE = "reconcile";

// Build the webhook URL from its id + token (the format Discord documents).
const webhookUrl = (webhook: DiscordWebhook): string => `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;

// Find or create a channel by name + type + optional parent in a guild.
const ensureChannel = async (
    api: DiscordApi,
    botToken: string,
    guildId: string,
    channels: readonly DiscordChannel[],
    name: string,
    type: number,
    parentId?: string,
): Promise<DiscordChannel> => {
    const existing = channels.find((ch) => ch.name === name && ch.type === type && ch.parent_id === parentId);
    if (existing !== undefined) {
        return existing;
    }
    return api.createChannel(botToken, guildId, name, type, parentId);
};

// Find or create a webhook named "intentic" on a channel.
const ensureWebhook = async (api: DiscordApi, botToken: string, channelId: string): Promise<DiscordWebhook> => {
    const webhooks = await api.getChannelWebhooks(botToken, channelId);
    const existing = webhooks.find((wh) => wh.name === WEBHOOK_NAME);
    if (existing !== undefined) {
        return existing;
    }
    return api.createWebhook(botToken, channelId, WEBHOOK_NAME);
};

// The detail shape we persist for drift detection.
interface DiscordDetail {
    readonly guildId: string;
    readonly channelNames: readonly string[];
    readonly webhookNames: readonly string[];
}

// Discord (the back-communication channel) as a managed guild + categories + channels + webhooks.
// read returns the guild if the bot owns one named "intentic – <zone>"; diff detects missing channels
// or webhooks for declared apps; apply creates/reconciles the full structure.
export const createDiscordProvider = (api: DiscordApi = discordApi): Provider => ({
    read: async (inputs, ctx) => {
        const parsed = parse(inputs);
        const name = guildName(parsed.zone);
        try {
            const guilds = await api.listGuilds(parsed.botToken);
            const guild = guilds.find((g) => g.name === name) ?? guilds[0];
            if (guild === undefined) {
                return undefined;
            }
            const channels = await api.getGuildChannels(parsed.botToken, guild.id);
            const channelNames = channels.filter((ch) => ch.type === CHANNEL_TYPE_TEXT).map((ch) => ch.name);

            // Collect webhook names across all text channels.
            const webhookNames: string[] = [];
            for (const ch of channels.filter((c) => c.type === CHANNEL_TYPE_TEXT)) {
                const webhooks = await api.getChannelWebhooks(parsed.botToken, ch.id);
                webhookNames.push(...webhooks.map((wh) => `${ch.name}:${wh.name}`));
            }

            // Resolve the reconcile webhook URL for the outputs.
            const reconcileChannel = channels.find((ch) => ch.name === CHANNEL_RECONCILE && ch.type === CHANNEL_TYPE_TEXT);
            let reconcileWebhookUrl = "";
            if (reconcileChannel !== undefined) {
                const webhooks = await api.getChannelWebhooks(parsed.botToken, reconcileChannel.id);
                const wh = webhooks.find((w) => w.name === WEBHOOK_NAME);
                if (wh !== undefined) {
                    reconcileWebhookUrl = webhookUrl(wh);
                }
            }

            // Resolve per-app webhook URLs for the outputs.
            const appWebhooks: Record<string, string> = {};
            for (const appId of parsed.apps) {
                const appChannel = channels.find((ch) => ch.name === appId && ch.type === CHANNEL_TYPE_TEXT);
                if (appChannel !== undefined) {
                    const webhooks = await api.getChannelWebhooks(parsed.botToken, appChannel.id);
                    const wh = webhooks.find((w) => w.name === WEBHOOK_NAME);
                    if (wh !== undefined) {
                        appWebhooks[`appWebhook:${appId}`] = webhookUrl(wh);
                    }
                }
            }

            return {
                outputs: { guildId: guild.id, reconcileWebhook: reconcileWebhookUrl, ...appWebhooks },
                detail: { guildId: guild.id, channelNames, webhookNames } satisfies DiscordDetail,
            };
        } catch (error) {
            ctx.log(`discord "${ctx.id}": Discord API not reachable, treating as not-yet-created: ${String(error)}`);
            return undefined;
        }
    },
    diff: (inputs, observed) => {
        const parsed = parse(inputs);
        const detail = observed.detail as DiscordDetail | undefined;
        if (detail === undefined) {
            return { action: "update", reason: "discord detail missing" };
        }
        // Check for the reconcile channel.
        if (!detail.channelNames.includes(CHANNEL_RECONCILE)) {
            return { action: "update", reason: `missing #${CHANNEL_RECONCILE} channel` };
        }
        // Check for per-app channels.
        for (const appId of parsed.apps) {
            if (!detail.channelNames.includes(appId)) {
                return { action: "update", reason: `missing #${appId} channel` };
            }
        }
        // Check for webhooks on the reconcile channel + each app channel.
        const requiredWebhooks = [CHANNEL_RECONCILE, ...parsed.apps].map((name) => `${name}:${WEBHOOK_NAME}`);
        for (const required of requiredWebhooks) {
            if (!detail.webhookNames.includes(required)) {
                return { action: "update", reason: `missing webhook ${required}` };
            }
        }
        return { action: "noop" };
    },
    apply: async (inputs, _observed, ctx) => {
        const parsed = parse(inputs);
        const name = guildName(parsed.zone);

        // Find or create the guild. Discord restricts POST /guilds for most bots (error 20001),
        // so we try to create and fall back to the first guild the bot is already in.
        const guilds = await api.listGuilds(parsed.botToken);
        let guild = guilds.find((g) => g.name === name) ?? guilds[0];
        if (guild === undefined) {
            try {
                ctx.log(`discord "${ctx.id}": creating guild "${name}"`);
                guild = await api.createGuild(parsed.botToken, name);
            } catch {
                throw new Error(
                    `discord "${ctx.id}": the bot is not in any guild and cannot create one. ` +
                        "Invite the bot to a Discord server first, then re-run apply.",
                );
            }
        }

        // Fetch current channels (including the defaults Discord creates).
        let channels = await api.getGuildChannels(parsed.botToken, guild.id);

        // Ensure categories.
        const intenticCategory = await ensureChannel(api, parsed.botToken, guild.id, channels, CATEGORY_INTENTIC, CHANNEL_TYPE_CATEGORY);
        // Refresh channel list after potential creation.
        channels = await api.getGuildChannels(parsed.botToken, guild.id);
        const appsCategory = await ensureChannel(api, parsed.botToken, guild.id, channels, CATEGORY_APPS, CHANNEL_TYPE_CATEGORY);
        channels = await api.getGuildChannels(parsed.botToken, guild.id);

        // Ensure the #reconcile channel under the "intentic" category.
        const reconcileChannel = await ensureChannel(
            api,
            parsed.botToken,
            guild.id,
            channels,
            CHANNEL_RECONCILE,
            CHANNEL_TYPE_TEXT,
            intenticCategory.id,
        );
        channels = await api.getGuildChannels(parsed.botToken, guild.id);

        // Ensure its webhook.
        const reconcileWh = await ensureWebhook(api, parsed.botToken, reconcileChannel.id);

        // Ensure per-app channels under "apps" category + their webhooks.
        const appWebhooks: Record<string, string> = {};
        for (const appId of parsed.apps) {
            const appChannel = await ensureChannel(api, parsed.botToken, guild.id, channels, appId, CHANNEL_TYPE_TEXT, appsCategory.id);
            channels = await api.getGuildChannels(parsed.botToken, guild.id);
            const wh = await ensureWebhook(api, parsed.botToken, appChannel.id);
            appWebhooks[`appWebhook:${appId}`] = webhookUrl(wh);
        }

        return { guildId: guild.id, reconcileWebhook: webhookUrl(reconcileWh), ...appWebhooks };
    },
});
