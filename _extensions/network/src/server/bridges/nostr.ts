import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { z } from "zod";
import type { BridgeItem } from "../records.js";
import { isoDate, recordOf, webUrl } from "./normalize.js";

const HEX = /^[0-9a-f]{64}$/u;
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
export const nostrAuthor = (value: string): string => {
    if (HEX.test(value)) {return value;}
    if (value !== value.toLowerCase() && value !== value.toUpperCase()) {throw new Error("Mixed-case npub");}
    const normalized = value.toLowerCase();
    if (!normalized.startsWith("npub1") || normalized.length !== 63) {throw new Error("Expected a hex public key or npub");}
    const words = Array.from(normalized.slice(5), (char) => BECH32.indexOf(char));
    if (words.some((word) => word < 0)) {throw new Error("Invalid npub character");}
    const hrp = [..."npub"].map((char) => char.charCodeAt(0));
    let check = 1;
    for (const word of [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...words]) {
        const top = check >>> 25;
        check = ((check & 0x1ffffff) << 5) ^ word;
        for (const [i, generator] of [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3].entries()) {if ((top >>> i) & 1) {check ^= generator;}}
    }
    if (check !== 1) {throw new Error("Invalid npub checksum");}
    const bytes: number[] = [];
    let accumulator = 0;
    let bits = 0;
    for (const word of words.slice(0, -6)) {
        accumulator = (accumulator << 5) | word;
        bits += 5;
        if (bits >= 8) { bits -= 8; bytes.push((accumulator >>> bits) & 255); }
    }
    if (bytes.length !== 32 || (accumulator & ((1 << bits) - 1)) !== 0) {throw new Error("Invalid npub padding");}
    return Buffer.from(bytes).toString("hex");
};
export const NostrEventSchema = z.object({
    id: z.string().regex(HEX), pubkey: z.string().regex(HEX), created_at: z.number().int().min(0).max(8640000000000),
    kind: z.union([z.literal(1), z.literal(30023)]), tags: z.array(z.array(z.string().max(4096)).max(20)).max(2000),
    content: z.string().max(100000), sig: z.string().regex(/^[0-9a-f]{128}$/u),
});
export type NostrEvent = z.infer<typeof NostrEventSchema>;
export const nostrEventId = (event: Omit<NostrEvent, "id" | "sig">): string => createHash("sha256").update(JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content])).digest("hex");
export const verifyNostr = (event: NostrEvent): boolean => {
    try { return nostrEventId(event) === event.id && schnorr.verify(Buffer.from(event.sig, "hex"), Buffer.from(event.id, "hex"), Buffer.from(event.pubkey, "hex")); }
    // allow(silent-catch): a malformed key or signature throws in the library; it verifies nothing
    catch { return false; }
};
export const parseNostr = (event: NostrEvent, relay: string): BridgeItem => {
    const tag = (name: string) => event.tags.find((entry) => entry[0] === name)?.[1];
    const url = webUrl(tag("r"));
    return { nativeId: event.id, nativeUrl: url, verification: verifyNostr(event) ? "signature-valid" : "signature-invalid", verifiedBy: "nostr-schnorr", signingKey: event.pubkey, record: recordOf("nostr", {
        "@type": event.kind === 1 ? "SocialMediaPosting" : "Article", headline: tag("title") ?? event.content.slice(0, 160),
        ...(event.kind === 1 ? { text: event.content } : { articleBody: event.content }), url,
        datePublished: isoDate(event.created_at * 1000), author: { "@type": "Person", name: event.pubkey, identifier: event.pubkey },
        isBasedOn: [relay, `nostr:${event.id}`], keywords: event.tags.filter((entry) => entry[0] === "t").flatMap((entry) => entry[1] ? [entry[1]] : []),
        image: webUrl(tag("image")) ? [webUrl(tag("image"))!] : [],
    }) };
};
