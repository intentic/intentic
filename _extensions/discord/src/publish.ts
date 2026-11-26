import { sleep } from "@intentic/base/async";
import type { ApprovedActionOutcome, ApprovedPost } from "@intentic/extension-api/runtime";

// AN APPROVED POST, PUBLISHED BY THE BOT (2026-11-26): what the daemon did itself until then (approvals/direct-publish.ts,
// through this extension's gateway), now this extension's own. The daemon hands a post here only after the person's yes
// was matched and spent, and only one whose target is a channel id (`channel.publish` on the card); everything else went
// to an agent turn instead. Plain REST over `fetch` with each connected bot's token, so the backend host loads no
// discord.js: the first bot that can see the channel posts it, as the gateway's /deliver door picks one.

const API = "https://discord.com/api/v10";
// How long a rate-limited post waits before its one retry; past this the post is refused for the owner to retry.
const RETRY_AFTER_MAX_MS = 10_000;

export interface PublishDeps {
    // The bot tokens of the connected Discord cards, in card order, duplicates dropped.
    readonly tokens: () => Promise<readonly string[]>;
    // The one-message limit the card declares (`channel.messageLimit`).
    readonly limit: number;
    readonly fetch?: Fetch;
    readonly sleep?: (ms: number) => Promise<void>;
}

// The one way a request reaches Discord: the real `fetch` unless a suite stands in for it.
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

type Io = Required<Pick<PublishDeps, "fetch" | "sleep">>;

const refused = (error: string): ApprovedActionOutcome => ({ outcome: "refused", error });

// The owner's rule for a bot's message as the sandbox reads it (the card's `message.send`, else every Discord action):
// a deny set after the yes still refuses.
const deniedByRule = (rules: Readonly<Record<string, string>>): boolean => (rules["discord.message.send"] ?? rules["discord.*"]) === "deny";

interface Channel {
    readonly guildId?: string;
}

interface Message {
    readonly id: string;
    readonly channelId: string;
}

// The JSON a Discord answer carries, read only where the fields asked for are strings.
const fieldsOf = async (response: Response, keys: readonly string[]): Promise<Readonly<Record<string, string>>> => {
    // allow(silent-catch): an answer that is not JSON carries none of the fields, which each caller says in words
    const body: unknown = await response.json().catch(() => undefined);
    const entries = body !== null && body !== undefined && !Array.isArray(body) ? Object.entries(body) : [];
    return Object.fromEntries(entries.filter(([key, value]) => keys.includes(key) && String(value) === value));
};

// The channel as one bot sees it; undefined when that bot cannot (not in the server, no access, a bad token).
const channelFor = async (deps: Pick<Io, "fetch">, token: string, channelId: string, signal: AbortSignal): Promise<Channel | undefined> => {
    const answered = await deps.fetch(`${API}/channels/${encodeURIComponent(channelId)}`, { headers: { authorization: `Bot ${token}` }, signal });
    if ([401, 403, 404].includes(answered.status)) {
        return undefined;
    }
    if (!answered.ok) {
        throw new Error(`Discord answered ${answered.status} when asked about channel ${channelId}`);
    }
    const { guild_id: guildId } = await fieldsOf(answered, ["guild_id"]);
    return guildId === undefined ? {} : { guildId };
};

// One message, posted once: a rate limit is waited out once, within RETRY_AFTER_MAX_MS. Throws `Refusal` for an answer
// that says nothing was posted, anything else for one that may have been.
class Refusal extends Error {}

const postOnce = async (
    deps: Io,
    token: string,
    channelId: string,
    content: string,
    signal: AbortSignal,
): Promise<Message> => {
    const send = (): Promise<Response> =>
        deps.fetch(`${API}/channels/${encodeURIComponent(channelId)}/messages`, {
            method: "POST",
            headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
            // Nobody is pinged by an approved post unless Discord's own syntax in it is meant: never @everyone by accident.
            body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
            signal,
        });
    let answered = await send();
    if (answered.status === 429) {
        const wait = Math.ceil(Number(answered.headers.get("retry-after") ?? "1") * 1_000);
        if (!Number.isFinite(wait) || wait > RETRY_AFTER_MAX_MS) {
            throw new Refusal(`Discord is rate-limiting this bot for ${answered.headers.get("retry-after") ?? "a while"}s`);
        }
        await deps.sleep(wait);
        answered = await send();
    }
    if (answered.status >= 400 && answered.status < 500) {
        const { message } = await fieldsOf(answered, ["message"]);
        throw new Refusal(`Discord refused the post (${answered.status}${message === undefined ? "" : `: ${message}`})`);
    }
    if (!answered.ok) {
        throw new Error(`Discord answered ${answered.status} while taking the post`);
    }
    const { id, channel_id: posted } = await fieldsOf(answered, ["id", "channel_id"]);
    if (id === undefined) {
        throw new Error("Discord took the post but named no message");
    }
    return { id, channelId: posted ?? channelId };
};

// One bot's go at it: undefined when that bot cannot see the channel, so the next is tried; else what posting came to.
const throughBot = async (io: Io, token: string, post: ApprovedPost, signal: AbortSignal): Promise<ApprovedActionOutcome | undefined> => {
    let channel: Channel | undefined;
    try {
        channel = await channelFor(io, token, post.target, signal);
    } catch (error) {
        // Only asked about the channel: nothing was posted.
        return refused(error instanceof Error ? error.message : "Discord could not be reached");
    }
    if (channel === undefined) {
        return undefined;
    }
    try {
        const message = await postOnce(io, token, post.target, post.content, signal);
        return { outcome: "done", result: `https://discord.com/channels/${channel.guildId ?? "@me"}/${message.channelId}/${message.id}` };
    } catch (error) {
        const words = error instanceof Error ? error.message : "the post failed";
        return error instanceof Refusal ? refused(words) : { outcome: "uncertain", error: words };
    }
};

// Why a post is refused before any bot is asked, or undefined when it may go.
const refusalBefore = (deps: PublishDeps, post: ApprovedPost, tokens: readonly string[]): string | undefined => {
    if (deniedByRule(post.actionRules)) {
        return "the owner's rules deny the Discord bot's messages now";
    }
    if (post.content.length > deps.limit) {
        return `Discord caps a message at ${deps.limit} characters and this one is ${post.content.length}`;
    }
    return tokens.length === 0 ? "Discord isn't connected in this workspace, so there is no bot to post as" : undefined;
};

/** Publishes one approved post into the channel its target names, through the first connected bot that can see it. */
export const publishPost = async (deps: PublishDeps, post: ApprovedPost, signal: AbortSignal): Promise<ApprovedActionOutcome> => {
    const tokens = await deps.tokens();
    const before = refusalBefore(deps, post, tokens);
    if (before !== undefined) {
        return refused(before);
    }
    const io: Io = { fetch: deps.fetch ?? fetch, sleep: deps.sleep ?? ((ms: number) => sleep(ms, { signal })) };
    for (const token of tokens) {
        const outcome = await throughBot(io, token, post, signal);
        if (outcome !== undefined) {
            return outcome;
        }
    }
    return refused(`no connected Discord bot can see channel ${post.target}: add the bot to that server, or check the channel id`);
};
