import { setTimeout as sleep } from "node:timers/promises";
import type { Services } from "../composition.js";

/* SENDING A DISCORD POST WITHOUT AN AGENT TURN, the whole reason the publisher splits by platform.
 *
 * Discord hands out a bot token and a documented endpoint, so posting is one authenticated request that either
 * returned 200 or did not. Everything an agent turn brings to a browser-driven platform, reading the page,
 * finding the box, noticing the dialog, is dead weight here, and it is weight measured in a whole model turn
 * per post. This is the fast path: milliseconds, no tokens, and an error you can put in front of the owner
 * verbatim instead of a transcript to read.
 *
 * IT IS DELIBERATELY NOT A DISCORD CLIENT. There is a full typed v10 wrapper in the deploy providers package
 * (guilds, channels, webhooks) and the sandbox does not depend on it, correctly: publishing needs exactly one
 * endpoint, and taking the dependency to reach it would drag the deploy engine's surface into the daemon for
 * the sake of a POST. What IS worth copying from it is the rate-limit dance below, which is the one piece of
 * Discord you cannot skip and get right by accident.
 *
 * MEDIA IS NOT SENT HERE. An attachment is a multipart upload of a workspace file, which is a second shape of
 * request, a second failure mode and a file-path trust boundary, so a draft carrying media is handed to the
 * turn instead (canPublishDirectly below). One endpoint, honestly scoped, beats two half-supported ones. */

const API_BASE = `https://discord.com/api/v10`;

// Discord's own ceiling. A longer draft is refused before the request rather than by it, so the owner gets a
// sentence about length instead of a 400 with a JSON body in it.
const MESSAGE_LIMIT = 2_000;

const MAX_RETRIES = 3;

// A channel id is a snowflake, digits, nothing else. Worth checking because `target` is free text written by
// the agent, and "#releases" reaching the URL builder is a 404 whose message says nothing about the real
// mistake.
const CHANNEL_ID = /^\d{5,}$/;

export interface DirectPostResult {
    /** The message's own URL, for the queue's posted row. */
    readonly url: string;
}

/* WHETHER THIS PARTICULAR DRAFT CAN GO THE FAST WAY. Platform alone is not enough: the same connector that
 * posts a line of text in one request needs a different one to carry a picture, and a draft addressed to
 * "#releases" instead of a channel id has nowhere to go. Both fall back to the turn, which can read the
 * server, find the channel by name, and upload the file, so a "no" here costs money rather than the post. */
export const canPublishDirectly = (draft: { readonly target?: string | undefined; readonly media?: readonly string[] | undefined }): boolean =>
    draft.target !== undefined && CHANNEL_ID.test(draft.target) && (draft.media ?? []).length === 0;

/* The token that posts as this workspace's bot. `cli` capability configs are a plain string map (the manifest
 * is on the secret denylist rather than encrypted), and `discord` is the id the connector registers under,
 * the same read the extension host does to hand the gateway its token. */
const botTokenOf = async (services: Pick<Services, `capabilities`>): Promise<string | undefined> => {
    const capability = await services.capabilities.get(`discord`);
    if (capability?.kind !== `cli`) {
        return undefined;
    }
    const token = capability.config[`botToken`];
    return token === undefined || token === `` ? undefined : token;
};

/* Discord answers 429 with the seconds to wait, and it means it, a retry that ignores the header earns a
 * longer ban than the one it skipped. Sleep exactly what it asked for plus a hair, up to MAX_RETRIES, then
 * give up and let the failure be the draft's error string. Every other non-2xx is final: a 403 is a permission
 * the owner has to grant, and hammering it changes nothing. */
const post = async (url: string, init: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt++) {
        // Bound a stalled connection, undici would otherwise wait about five minutes on headers.
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

/* POST one draft into one channel. Throws with a sentence the queue can show as-is, this runs with nobody
 * watching, so the error IS the report. */
export const postToDiscord = async (
    services: Pick<Services, `capabilities`>,
    draft: { readonly content: string; readonly target?: string | undefined },
): Promise<DirectPostResult> => {
    const channelId = draft.target;
    if (channelId === undefined || !CHANNEL_ID.test(channelId)) {
        throw new Error(`This draft has no Discord channel id to post into.`);
    }
    if (draft.content.length > MESSAGE_LIMIT) {
        throw new Error(
            `Discord caps a message at ${MESSAGE_LIMIT.toLocaleString()} characters and this one is ${draft.content.length.toLocaleString()}.`,
        );
    }
    const botToken = await botTokenOf(services);
    if (botToken === undefined) {
        throw new Error(`Discord isn't connected in this workspace, so there is no bot to post as.`);
    }
    const response = await post(`${API_BASE}/channels/${channelId}/messages`, {
        method: `POST`,
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": `application/json` },
        body: JSON.stringify({ content: draft.content }),
    });
    // The id and the guild are what build a link a person can click. Discord always returns both on a send;
    // a body that somehow lacks them still posted, so the post is not failed over a missing URL.
    const sent = (await response.json().catch(() => ({}))) as { id?: string; guild_id?: string };
    const guild = sent.guild_id ?? `@me`;
    return { url: sent.id === undefined ? `${API_BASE}/channels/${channelId}` : `https://discord.com/channels/${guild}/${channelId}/${sent.id}` };
};
