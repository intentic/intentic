import { setTimeout as sleep } from "node:timers/promises";
import type { Services } from "../composition.js";

// Posts to Discord without an agent turn: one authenticated request to a documented endpoint, instead of a
// browser-driven turn.
// Not a full Discord client on purpose: only one endpoint is needed, though the rate-limit handling below is worth
// getting right.
// Media isn't sent here either: an attachment is a multipart upload with its own trust boundary, so it goes to the turn
// instead.

const API_BASE = `https://discord.com/api/v10`;

// Discord's own ceiling; refused up front so the owner gets a plain sentence, not a 400 with a JSON body.
const MESSAGE_LIMIT = 2_000;

const MAX_RETRIES = 3;

// A channel id is digits only; target is agent text, and an unchecked "#releases" would 404 unhelpfully.
const CHANNEL_ID = /^\d{5,}$/;

export interface DirectPostResult {
    /** The message's own URL, for the queue's posted row. */
    readonly url: string;
}

// Whether this draft can go the fast way: platform alone isn't enough, since media or a non-id target need the turn
// instead.
// Both fall back to the turn, which can read the server, find the channel by name, and upload the file; a "no" here
// costs money, not the post.
export const canPublishDirectly = (post: { readonly target?: string | undefined; readonly media?: readonly string[] | undefined }): boolean =>
    post.target !== undefined && CHANNEL_ID.test(post.target) && (post.media ?? []).length === 0;

// The token that posts as this workspace's bot, read from the `discord` cli capability's config.
// `cli` configs are a plain string map (the manifest sits on the secret denylist, not encrypted).
const botTokenOf = async (services: Pick<Services, `capabilities`>): Promise<string | undefined> => {
    const capability = await services.capabilities.get(`discord`);
    if (capability?.kind !== `cli`) {
        return undefined;
    }
    const token = capability.config[`botToken`];
    return token === undefined || token === `` ? undefined : token;
};

// Discord answers 429 with the seconds to wait, and means it: ignoring the header earns a longer ban than the one it
// skipped.
// Sleeps exactly what it asked plus a hair, up to MAX_RETRIES; every other non-2xx is final (e.g. a 403 needs an
// owner-granted permission).
const send = async (url: string, init: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
        // Bounds a stalled connection; undici would otherwise wait about five minutes on headers.
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
        if (response.status === 429 && attempt < MAX_RETRIES) {
            const body = (await response.json().catch(() => ({}))) as { retry_after?: number };
            await sleep(((body.retry_after ?? 1) + 0.1) * 1_000);
            continue;
        }
        if (!response.ok) {
            throw new Error(`Discord refused the post (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
        }
        return response;
    }
};

// Posts one message into one channel.
// Throws with a sentence the queue can show as-is: nobody is watching, so the error is the report.
export const postToDiscord = async (
    services: Pick<Services, `capabilities`>,
    post: { readonly content: string; readonly target?: string | undefined },
): Promise<DirectPostResult> => {
    const channelId = post.target;
    if (channelId === undefined || !CHANNEL_ID.test(channelId)) {
        throw new Error(`This post has no Discord channel id to post into.`);
    }
    if (post.content.length > MESSAGE_LIMIT) {
        throw new Error(
            `Discord caps a message at ${MESSAGE_LIMIT.toLocaleString()} characters and this one is ${post.content.length.toLocaleString()}.`,
        );
    }
    const botToken = await botTokenOf(services);
    if (botToken === undefined) {
        throw new Error(`Discord isn't connected in this workspace, so there is no bot to post as.`);
    }
    const response = await send(`${API_BASE}/channels/${channelId}/messages`, {
        method: `POST`,
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": `application/json` },
        body: JSON.stringify({ content: post.content }),
    });
    // The id and guild build a clickable link; a response somehow missing them still means the post succeeded.
    const sent = (await response.json().catch(() => ({}))) as { id?: string; guild_id?: string };
    const guild = sent.guild_id ?? `@me`;
    return { url: sent.id === undefined ? `${API_BASE}/channels/${channelId}` : `https://discord.com/channels/${guild}/${channelId}/${sent.id}` };
};
