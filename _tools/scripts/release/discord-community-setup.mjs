#!/usr/bin/env node
// One-time, idempotent setup for the community Discord: an `info` category, a read-only `#announcements` channel, the
// `intentic-releases` webhook CI posts through, and a pinned guide. Prints the webhook URL (a credential) to store as
// GitHub secret `DISCORD_RELEASE_WEBHOOK`, never writes it into the repo. The read-only-role and pin steps warn rather
// than fail.
// Manage Channels create and order the category and channel
// Manage Webhooks create the webhook CI posts through
// Manage Roles deny @everyone Send Messages
// Pin Messages pin the guide (separate from Manage Messages)
// Send Messages post the guide

const API = "https://discord.com/api/v10";
const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN_DISCORD ?? "";
const guildMatch = (process.argv[2] ?? "intentic").toLowerCase();

if (!token) {
    console.error("DISCORD_BOT_TOKEN is required.");
    process.exit(1);
}

// Discord permission bits; serialised as decimal strings of a 64-bit field.
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADD_REACTIONS = 1n << 6n;
const CREATE_PUBLIC_THREADS = 1n << 35n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const EMBED_LINKS = 1n << 14n;

const CHANNEL_TYPE = { text: 0, category: 4 };

const warnings = [];

/** One Discord REST call; throws with the API's own error text so a 403 names the missing permission. */
async function discord(method, path, body) {
    const init = { method, headers: { authorization: `Bot ${token}` } };
    if (body !== undefined) {
        init.headers["content-type"] = "application/json";
        init.body = JSON.stringify(body);
    }
    const response = await fetch(`${API}${path}`, init);
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`${method} ${path} → ${response.status} ${text}`);
    }
    return text ? JSON.parse(text) : undefined;
}

const guilds = await discord("GET", "/users/@me/guilds");
const guild = guilds.find((candidate) => candidate.name.toLowerCase().includes(guildMatch));
if (!guild) {
    console.error(`No guild matching "${guildMatch}". Bot is in: ${guilds.map((g) => g.name).join(", ")}`);
    process.exit(1);
}
const bot = await discord("GET", "/users/@me");

console.log(`==> guild: ${guild.name} (${guild.id}) as ${bot.username}`);

let channels = await discord("GET", `/guilds/${guild.id}/channels`);

/** Find or create a channel, matching on name + type + parent so `#app` under `apps` never matches. */
async function ensureChannel(name, type, { parentId, ...extra } = {}) {
    const existing = channels.find(
        (channel) => channel.name === name && channel.type === type && (parentId === undefined || channel.parent_id === parentId),
    );
    if (existing) {
        console.log(`    exists   ${type === CHANNEL_TYPE.category ? name : `#${name}`} (${existing.id})`);
        return existing;
    }
    const created = await discord("POST", `/guilds/${guild.id}/channels`, {
        name,
        type,
        ...(parentId === undefined ? {} : { parent_id: parentId }),
        ...extra,
    });
    console.log(`    created  ${type === CHANNEL_TYPE.category ? name : `#${name}`} (${created.id})`);
    channels = await discord("GET", `/guilds/${guild.id}/channels`);
    return created;
}

const category = await ensureChannel("info", CHANNEL_TYPE.category, { position: 0 });
const announcements = await ensureChannel("announcements", CHANNEL_TYPE.text, {
    parentId: category.id,
    topic: "Release notes and product news for intentic. Read-only — questions go to #general, bugs to GitHub Issues.",
});

// `position: 0` alone doesn't work: Discord breaks a tie among same-position categories by age, so a fresh category
// still sinks last. Reorders by sending every sibling's position, `info` first, in place.
const categories = channels.filter((channel) => channel.type === CHANNEL_TYPE.category);
const ordered = [
    category,
    ...categories
        .filter((candidate) => candidate.id !== category.id)
        .toSorted((a, b) => a.position - b.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1)),
];
if (ordered.some((channel, index) => channel.position !== index)) {
    await discord(
        "PATCH",
        `/guilds/${guild.id}/channels`,
        ordered.map((channel, index) => ({ id: channel.id, position: index })),
    );
    console.log(`    ordered  info above ${ordered.length - 1} other categor${ordered.length === 2 ? "y" : "ies"}`);
}

// Bot's own role gets an allow overwrite first: an @everyone deny for Send Messages applies to the bot too, and
// skipping this would lock the bot (and the guide post below) out of the channel it just made.
const botRole = (await discord("GET", `/guilds/${guild.id}/roles`)).find((role) => role.tags?.bot_id === bot.id);
try {
    if (botRole) {
        await discord("PUT", `/channels/${announcements.id}/permissions/${botRole.id}`, {
            type: 0,
            allow: String(VIEW_CHANNEL | SEND_MESSAGES | READ_MESSAGE_HISTORY | ADD_REACTIONS | EMBED_LINKS),
            deny: "0",
        });
        console.log(`    set      #announcements writable by the bot`);
    }
    await discord("PUT", `/channels/${announcements.id}/permissions/${guild.id}`, {
        type: 0,
        allow: String(VIEW_CHANNEL | READ_MESSAGE_HISTORY | ADD_REACTIONS),
        deny: String(SEND_MESSAGES | CREATE_PUBLIC_THREADS | SEND_MESSAGES_IN_THREADS),
    });
    console.log(`    set      #announcements read-only for @everyone`);
} catch (error) {
    warnings.push(
        `Could not make #announcements read-only (needs Manage Roles on the bot's role): ${error.message}\n` +
            `    Fix by hand: the channel's own permissions → @everyone → deny Send Messages in #announcements.`,
    );
}

// Webhook CI posts through; needs no bot presence at post time and carries no other rights.
const webhooks = await discord("GET", `/channels/${announcements.id}/webhooks`);
let webhook = webhooks.find((candidate) => candidate.name === "intentic-releases" && candidate.token);
if (webhook) {
    console.log(`    exists   webhook intentic-releases (${webhook.id})`);
} else {
    webhook = await discord("POST", `/channels/${announcements.id}/webhooks`, { name: "intentic-releases" });
    console.log(`    created  webhook intentic-releases (${webhook.id})`);
}
const webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;

// Pinned guide for an empty channel: what it carries, and where to ask instead.
const guide = [
    "**What lands here**",
    "",
    "Release notes for intentic, posted automatically when a release changes something you would notice — new features, behaviour changes, breaking changes. Releases with nothing user-facing in them are skipped, so this channel stays readable.",
    "",
    "· **Questions and feedback** → <#GENERAL_ID>",
    "· **Bugs** → <https://github.com/intentic/intentic/issues>",
    "· **Every release, including the internal ones** → <https://github.com/intentic/intentic/releases>",
    "· **Full changelog** → <https://intentic.dev/changelog>",
].join("\n");

const general = channels.find((channel) => channel.name === "general" && channel.type === CHANNEL_TYPE.text);
const content = general ? guide.replace("<#GENERAL_ID>", `<#${general.id}>`) : guide.replace(" → <#GENERAL_ID>", "");

// Checks for an already-posted guide by author, not by what's pinned (pin permission may be missing). `type === 0`
// excludes the system message pinning emits under the same bot, which the next run would mistake for the guide.
const recent = await discord("GET", `/channels/${announcements.id}/messages?limit=50`);
let guideMessage = recent.find((message) => message.type === 0 && message.author?.id === bot.id && !message.webhook_id);
if (guideMessage) {
    console.log(`    exists   channel guide (${guideMessage.id})`);
} else {
    guideMessage = await discord("POST", `/channels/${announcements.id}/messages`, { content });
    console.log(`    posted   channel guide (${guideMessage.id})`);
}

const pins = await discord("GET", `/channels/${announcements.id}/messages/pins`).catch(() => ({ items: [] }));
if ((pins.items ?? []).some((pin) => (pin.message ?? pin).id === guideMessage.id)) {
    console.log(`    exists   pinned channel guide`);
} else {
    try {
        await discord("PUT", `/channels/${announcements.id}/messages/pins/${guideMessage.id}`);
        console.log(`    pinned   channel guide`);
    } catch (error) {
        warnings.push(
            `Could not pin the channel guide (needs Pin Messages — a SEPARATE permission from Manage ` +
                `Messages, which is not enough on its own): ${error.message}\n` +
                `    Fix by hand: right-click the message in #announcements → Pin.`,
        );
    }
}

for (const warning of warnings) {
    console.log(`\n!!  ${warning}`);
}

console.log(`\n==> Store this as GitHub secret DISCORD_RELEASE_WEBHOOK (it is a credential — do not commit it):`);
console.log(webhookUrl);
console.log(`\n==> Channel: https://discord.com/channels/${guild.id}/${announcements.id}`);
