import { messageLimitOf } from "@intentic/sandbox-contract";
import type { Services } from "../composition.js";
import { deliverThroughGateway } from "../extensions/listener/listener-deliver.js";

// Publishes an approved post without an agent turn, through the same door every other message the daemon sends takes:
// the provider's gateway and its /deliver route, which holds the bot's credential, its rate-limit handling and its idea
// of which bot can see the channel. Replaced (2026-10-06) a second Discord REST client here that read the bot token by
// a hard-coded capability id and handled 429s on its own.
// Media isn't sent this way: an attachment is a multipart upload with its own trust boundary, so it goes to the turn.

// A channel id is digits only; target is agent text, and an unchecked "#releases" would be refused unhelpfully.
const CHANNEL_ID = /^\d{5,}$/;

export interface DirectPostResult {
    /** The message's own URL, for the queue's posted row, when the gateway could name one. */
    readonly url?: string;
}

// Whether this draft can go the fast way: platform alone isn't enough, since media or a non-id target need the turn
// instead. Both fall back to the turn, which can read the server, find the channel by name, and upload the file; a "no"
// here costs money, not the post.
export const canPublishDirectly = (post: { readonly target?: string | undefined; readonly media?: readonly string[] | undefined }): boolean =>
    post.target !== undefined && CHANNEL_ID.test(post.target) && (post.media ?? []).length === 0;

const capitalized = (platform: string): string => platform.charAt(0).toUpperCase() + platform.slice(1);

// Posts one message into one channel. Throws with a sentence the queue can show as-is: nobody is watching, so the error
// is the report. Over the platform's one-message ceiling it refuses rather than letting the gateway spill it into
// several, since the inbox told the owner such a post would not post.
export const publishDirectly = async (
    services: Services,
    post: { readonly platform: string; readonly content: string; readonly target?: string | undefined },
): Promise<DirectPostResult> => {
    const platform = post.platform.toLowerCase();
    const name = capitalized(platform);
    const channelId = post.target;
    if (channelId === undefined || !CHANNEL_ID.test(channelId)) {
        throw new Error(`This post has no ${name} channel id to post into.`);
    }
    const limit = messageLimitOf(platform);
    if (limit !== undefined && post.content.length > limit) {
        throw new Error(`${name} caps a message at ${limit.toLocaleString()} characters and this one is ${post.content.length.toLocaleString()}.`);
    }
    const delivered = await deliverThroughGateway(services, platform, channelId, post.content);
    if (delivered === undefined) {
        throw new Error(`${name} isn't connected in this workspace, so there is no bot to post as.`);
    }
    return delivered;
};
