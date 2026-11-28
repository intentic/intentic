import { schnorr } from "@noble/curves/secp256k1.js";
import { falcon1024 } from "@noble/post-quantum/falcon.js";
import { atlasHash, contentCid, parseAtlas, verifyAtlas } from "./atlas.js";
import { parseBluesky } from "./bluesky.js";
import { nostrAuthor, nostrEventId, type NostrEvent, parseNostr, verifyNostr } from "./nostr.js";
import { parseFeed } from "./rss.js";

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Example</title><language>pl</language>
    <item>
      <title>First &amp; foremost</title>
      <link>https://example.com/a</link>
      <guid>urn:a</guid>
      <pubDate>Fri, 27 Nov 2026 10:00:00 GMT</pubDate>
      <dc:creator>Ada</dc:creator>
      <category>energy</category>
      <content:encoded><![CDATA[<p>Hello <b>world</b></p><script>alert(1)</script>]]></content:encoded>
    </item>
  </channel>
</rss>`;

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <title>Atom</title>
  <author><name>Grace</name><uri>https://grace.example</uri></author>
  <entry>
    <id>tag:example.com,2026:1</id>
    <title>Atom entry</title>
    <link rel="alternate" href="/posts/1"/>
    <published>2026-11-27T09:00:00Z</published>
    <summary>Short</summary>
    <category term="science"/>
  </entry>
</feed>`;

const JSON_FEED = JSON.stringify({
    version: `https://jsonfeed.org/version/1.1`,
    language: `en`,
    authors: [{ name: `Lin` }],
    items: [{ id: `j1`, url: `https://example.com/j1`, title: `JSON item`, content_text: `Plain body`, date_published: `2026-11-26T08:00:00Z`, tags: [`ai`] }],
});

describe(`feeds`, () => {
    it(`normalizes RSS 2.0 to schema.org without markup or scripts`, () => {
        const [item] = parseFeed(RSS, `https://example.com/feed.xml`);
        expect(item?.verification).toBe(`unsigned`);
        expect(item?.record).toMatchObject({
            "@type": `Article`,
            headline: `First & foremost`,
            articleBody: `Hello world`,
            url: `https://example.com/a`,
            datePublished: `2026-11-27T10:00:00.000Z`,
            author: { "@type": `Person`, name: `Ada` },
            inLanguage: `pl`,
            keywords: [`energy`],
            sdPublisher: { name: `intentic.network/rss` },
            isBasedOn: [`https://example.com/feed.xml`, `urn:a`],
        });
    });

    it(`resolves Atom's relative links and feed-level author`, () => {
        const [item] = parseFeed(ATOM, `https://example.com/atom.xml`);
        expect(item?.nativeId).toBe(`tag:example.com,2026:1`);
        expect(item?.record.url).toBe(`https://example.com/posts/1`);
        expect(item?.record.author).toMatchObject({ name: `Grace`, url: `https://grace.example/` });
        expect(item?.record.keywords).toEqual([`science`]);
        expect(item?.record.inLanguage).toBe(`en`);
    });

    it(`reads JSON Feed`, () => {
        const [item] = parseFeed(JSON_FEED, `https://example.com/feed.json`);
        expect(item?.record).toMatchObject({ "@type": `BlogPosting`, headline: `JSON item`, articleBody: `Plain body`, author: { name: `Lin` }, keywords: [`ai`] });
    });

    it(`refuses what is no feed`, () => {
        expect(() => parseFeed(`<html><body>nope</body></html>`, `https://example.com/`)).toThrow(`Expected RSS 2.0, Atom or JSON Feed`);
    });
});

describe(`bluesky`, () => {
    it(`maps an author feed's posts, the at:// uri kept as the native id`, () => {
        const feed = {
            feed: [
                {
                    post: {
                        uri: `at://did:plc:abc/app.bsky.feed.post/3k`,
                        author: { did: `did:plc:abc`, handle: `ada.bsky.social`, displayName: `Ada` },
                        record: { text: `Hello Bluesky`, createdAt: `2026-11-27T10:00:00Z`, langs: [`en`] },
                    },
                },
            ],
        };
        const [item] = parseBluesky(JSON.stringify(feed), `ada.bsky.social`);
        expect(item?.nativeId).toBe(`at://did:plc:abc/app.bsky.feed.post/3k`);
        expect(item?.record).toMatchObject({
            "@type": `SocialMediaPosting`,
            text: `Hello Bluesky`,
            url: `https://bsky.app/profile/did%3Aplc%3Aabc/post/3k`,
            author: { name: `Ada`, identifier: `did:plc:abc` },
            inLanguage: `en`,
        });
    });
});

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString(`hex`);

const signedEvent = (content: string): NostrEvent => {
    const secret = schnorr.utils.randomSecretKey();
    const pubkey = toHex(schnorr.getPublicKey(secret));
    const unsigned = { pubkey, created_at: 1_795_800_000, kind: 1 as const, tags: [[`t`, `nostr`]], content };
    const id = nostrEventId(unsigned);
    return { ...unsigned, id, sig: toHex(schnorr.sign(Buffer.from(id, `hex`), secret)) };
};

describe(`nostr`, () => {
    it(`decodes the NIP-19 npub test vector`, () => {
        expect(nostrAuthor(`npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg`)).toBe(`7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e`);
    });

    it(`refuses an npub with a broken checksum`, () => {
        expect(() => nostrAuthor(`npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjpth`)).toThrow(`checksum`);
    });

    it(`verifies a signed event, and keeps the key apart from the claimed author`, () => {
        const event = signedEvent(`gm`);
        expect(verifyNostr(event)).toBe(true);
        const item = parseNostr(event, `wss://relay.example`);
        expect(item).toMatchObject({ verification: `signature-valid`, verifiedBy: `nostr-schnorr`, signingKey: event.pubkey });
        expect(item.record).toMatchObject({ "@type": `SocialMediaPosting`, text: `gm`, keywords: [`nostr`] });
    });

    it(`marks a tampered event invalid`, () => {
        const event = { ...signedEvent(`gm`), content: `gn` };
        expect(verifyNostr(event)).toBe(false);
        expect(parseNostr(event, `wss://relay.example`).verification).toBe(`signature-invalid`);
    });
});

describe(`atlas`, () => {
    const keys = falcon1024.keygen();
    const publicKey = Buffer.from(keys.publicKey).toString(`base64`);
    const data = { "@context": `https://schema.org`, "@type": `SocialMediaPosting`, text: `Hello from Atlas.`, datePublished: `2026-04-03T12:00:00.000Z` };
    const envelope = { signature: Buffer.from(falcon1024.sign(atlasHash(data, publicKey), keys.secretKey)).toString(`base64`), data, author: { PublicKey: publicKey } };

    it(`names the content by a CIDv1 raw sha2-256 in base32`, () => {
        expect(contentCid(data)).toMatch(/^bafkrei[a-z2-7]{52}$/u);
    });

    it(`verifies a Falcon-1024 envelope made by the documented hash`, () => {
        expect(verifyAtlas(envelope, publicKey)).toBe(true);
        const [item] = parseAtlas(JSON.stringify([envelope]), `https://registry.example`);
        expect(item).toMatchObject({ verification: `signature-valid`, verifiedBy: `atlas-falcon1024`, signingKey: publicKey });
        expect(item?.record).toMatchObject({ "@type": `SocialMediaPosting`, text: `Hello from Atlas.` });
    });

    it(`marks a changed envelope invalid`, () => {
        const changed = { ...envelope, data: { ...data, text: `Changed.` } };
        expect(verifyAtlas(changed, publicKey)).toBe(false);
        expect(parseAtlas(JSON.stringify({ envelopes: [changed] }), `https://registry.example`)[0]?.verification).toBe(`signature-invalid`);
    });
});
