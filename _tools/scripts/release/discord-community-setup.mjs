#!/usr/bin/env node
/* One-time setup for the community Discord: an `info` category, a member-read-only `#announcements`
 * channel, the `intentic-releases` webhook CI posts through, and a pinned channel guide.
 *
 *   DISCORD_BOT_TOKEN=… node _tools/scripts/release/discord-community-setup.mjs [guild-name-substring]
 *
 * The guild substring defaults to "intentic" and is matched case-insensitively against the guilds the bot
 * is a member of. Every step is idempotent: re-running finds what exists instead of creating a duplicate.
 *
 * Prints the webhook URL to store as GitHub secret DISCORD_RELEASE_WEBHOOK. That URL is a credential —
 * anyone holding it can post to the channel — so it is printed, never written into the repository.
 *
 * PERMISSIONS the bot's role needs, and what each one is actually for:
 *   Manage Channels   create the category and the channel, and order them
 *   Manage Webhooks   create the webhook CI posts through
 *   Manage Roles      deny @everyone Send Messages, which is what "read-only" means here
 *   Pin Messages      pin the guide — NOT Manage Messages. Discord split pinning into its own permission
 *                     (1 << 51), so a bot holding Manage Messages still gets 403 Missing Permissions on the
 *                     pin routes, which is a confusing way to learn the two came apart.
 *   Send Messages     post the guide in the first place
 * The last two steps are reported as warnings rather than failing the run: the channel, the webhook and the
 * guide all still land without them, and the release pipeline only needs the webhook.
 *
 * Invite covering all of it: permissions=2251800620117072
 * https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot&permissions=2251800620117072
 */

const API = "https://discord.com/api/v10";
const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_BOT_TOKEN_DISCORD ?? "";
const guildMatch = (process.argv[2] ?? "intentic").toLowerCase();

if (!token) {
    console.error("DISCORD_BOT_TOKEN is required.");
    process.exit(1);
}

/* Permission bits used below. Discord serialises these as decimal strings of a 64-bit field. */
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const READ_MESSAGE_HISTORY = 1n << 16n;
const ADD_REACTIONS = 1n << 6n;
const CREATE_PUBLIC_THREADS = 1n << 35n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const EMBED_LINKS = 1n << 14n;

const CHANNEL_TYPE = { text: 0, category: 4 };

const warnings = [];

/** One Discord REST call. Throws with the API's own error text so a 403 says which permission is missing. */
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

/* `position: 0` on create is not enough, and neither is patching this one category to 0: a server that never
 * reordered anything has EVERY category at 0, and Discord breaks that tie by age, so the newest sinks to the
 * bottom no matter what number it carries. Renumbering only works if every sibling is given a distinct
 * position, so send the whole list — `info` first, the rest in the order they already appear. Announcements
 * under the ops categories is a channel nobody scrolls to. */
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

/* Members read, react and follow along; only the webhook and the bot write. Needs Manage Roles.
 *
 * The bot's own role gets an overwrite FIRST, and it is not optional: an @everyone deny applies to every
 * member, the bot included, so denying Send Messages here without re-allowing it for the bot locks the bot
 * out of the channel it just made — and the guide below would 403 on a fresh server. Webhook posts are
 * unaffected either way, which is why the release pipeline keeps working regardless. */
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

/* The webhook CI posts through. A webhook needs no bot presence at post time and carries no other rights. */
const webhooks = await discord("GET", `/channels/${announcements.id}/webhooks`);
let webhook = webhooks.find((candidate) => candidate.name === "intentic-releases" && candidate.token);
if (webhook) {
    console.log(`    exists   webhook intentic-releases (${webhook.id})`);
} else {
    webhook = await discord("POST", `/channels/${announcements.id}/webhooks`, { name: "intentic-releases" });
    console.log(`    created  webhook intentic-releases (${webhook.id})`);
}
const webhookUrl = `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;

/* A pinned guide so someone arriving at an empty channel knows what it carries and where to ask instead. */
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

/* Re-run safety: ask whether the guide is already POSTED, not whether anything is pinned. Pinning needs a
 * permission the bot may not have, and gating on the pin list would post a second copy on every re-run for
 * exactly as long as that permission is missing. The bot's own messages are the honest marker — CI posts
 * through the webhook, so a message authored by the bot user itself is this guide and nothing else.
 *
 * `type === 0` is load-bearing. Pinning emits a "<bot> pinned a message to this channel" SYSTEM message
 * (type 6) attributed to the same bot user, so the run right after a successful pin would find that instead
 * of the guide and try to pin it — `400 Cannot execute action on a system message`. Only DEFAULT messages
 * are things this script wrote. */
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
