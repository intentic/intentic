import { z } from "zod";
import type { BridgeItem } from "../records.js";
import { isoDate, recordOf, webUrl } from "./normalize.js";

const Feed = z.looseObject({ feed: z.array(z.looseObject({ post: z.looseObject({
    uri: z.string().startsWith("at://"),
    author: z.looseObject({ did: z.string(), handle: z.string(), displayName: z.string().optional() }),
    record: z.looseObject({ text: z.string(), createdAt: z.string().optional(), langs: z.array(z.string()).optional(), tags: z.array(z.string()).optional() }),
    embed: z.looseObject({ images: z.array(z.looseObject({ fullsize: z.string() })).optional() }).optional(),
}) })) });
// The AppView's answer, read from its JSON text here at the boundary.
export const parseBluesky = (body: string, actor: string): BridgeItem[] => Feed.parse(JSON.parse(body)).feed.slice(0, 100).map(({ post }) => {
    const key = post.uri.split("/").at(-1)!;
    const profile = `https://bsky.app/profile/${encodeURIComponent(post.author.did)}`;
    const url = `${profile}/post/${encodeURIComponent(key)}`;
    return { nativeId: post.uri, nativeUrl: url, verification: "unsigned", record: recordOf("bluesky", {
        "@type": "SocialMediaPosting", headline: post.record.text.slice(0, 160), text: post.record.text, url,
        datePublished: isoDate(post.record.createdAt),
        author: { "@type": "Person", name: post.author.displayName ?? post.author.handle, identifier: post.author.did, url: profile },
        isBasedOn: [`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(actor)}`, post.uri],
        inLanguage: post.record.langs?.[0], keywords: post.record.tags,
        image: post.embed?.images?.flatMap((image) => { const full = webUrl(image.fullsize); return full ? [full] : []; }),
    }) };
});
