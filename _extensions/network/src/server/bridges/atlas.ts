import { createHash } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3.js";
import { falcon1024 } from "@noble/post-quantum/falcon.js";
import { stringify } from "safe-stable-stringify";
import { z } from "zod";
import { RecordTypeSchema, type BridgeItem } from "../records.js";
import { isoDate, recordOf, webUrl } from "./normalize.js";

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
// An envelope's `data` exactly as it arrived: what the hash and the signature are over, never reshaped.
type AtlasJson = { readonly [key: string]: z.core.util.JSONType };
const AtlasJsonSchema = z.record(z.string(), z.json());

const stableJson = (data: AtlasJson): string => {
    const encoded = stringify(data);
    if (encoded === undefined) {throw new Error("Atlas data is not JSON");}
    return encoded;
};
// 2026-11-28: the docs name a SHA-256 CID but do not pin the codec or JSON encoding. Keep this assumption isolated.
export const contentCid = (data: AtlasJson): string => {
    const bytes = Buffer.concat([Buffer.from([1, 0x55, 0x12, 0x20]), createHash("sha256").update(stableJson(data)).digest()]);
    let accumulator = 0;
    let bits = 0;
    let text = "b";
    for (const byte of bytes) {
        accumulator = (accumulator << 8) | byte;
        bits += 8;
        while (bits >= 5) { bits -= 5; text += BASE32[(accumulator >>> bits) & 31]; }
    }
    if (bits) {text += BASE32[(accumulator << (5 - bits)) & 31];}
    return text;
};
const AtlasDataSchema = z.looseObject({
    "@type": z.string().optional(), headline: z.string().optional(), name: z.string().optional(), text: z.string().optional(), articleBody: z.string().optional(),
    url: z.string().optional(), datePublished: z.string().optional(), inLanguage: z.string().optional(),
    author: z.looseObject({ "@type": z.string().optional(), name: z.string().optional(), url: z.string().optional(), identifier: z.string().optional(), PublicKey: z.string().optional() }).optional(),
    // Schema.org allows one value or many; read both as a list.
    keywords: z.union([z.array(z.string()), z.string().transform((value) => [value])]).optional(),
    image: z.union([z.array(z.string()), z.string().transform((value) => [value])]).optional(),
});
export const AtlasEnvelopeSchema = z.looseObject({
    signature: z.string().max(8192), data: AtlasJsonSchema,
    author: z.object({ PublicKey: z.string().max(4096) }).optional(), contentHash: z.string().optional(),
    encryptedData: z.null().optional(), encryptionNonce: z.null().optional(), expiresAt: z.null().optional(), kemCiphertext: z.null().optional(), recipientHash: z.null().optional(),
});
export type AtlasEnvelope = z.infer<typeof AtlasEnvelopeSchema>;
export const atlasHash = (data: AtlasJson, publicKey: string): Uint8Array => blake3(new TextEncoder().encode(stableJson({
    author: { PublicKey: publicKey }, contentHash: contentCid(data), data, encryptedData: null, encryptionNonce: null, expiresAt: null, kemCiphertext: null, recipientHash: null,
})));
const base64 = (value: string): Uint8Array => {
    const bytes = Buffer.from(value, "base64");
    if (bytes.toString("base64") !== value) {throw new Error("Noncanonical base64");}
    return bytes;
};
export const verifyAtlas = (envelope: AtlasEnvelope, publicKey: string): boolean => {
    try {
        if (envelope.contentHash && envelope.contentHash !== contentCid(envelope.data)) {return false;}
        return falcon1024.verify(base64(envelope.signature), atlasHash(envelope.data, publicKey), base64(publicKey));
    // allow(silent-catch): a key or signature of the wrong length throws in the library; it verifies nothing
    } catch { return false; }
};
export const parseAtlas = (body: string, registry: string): BridgeItem[] => {
    const decoded = JSON.parse(body);
    const envelopes = z.union([z.array(AtlasEnvelopeSchema), z.object({ envelopes: z.array(AtlasEnvelopeSchema) }).transform((value) => value.envelopes)]).parse(decoded);
    return envelopes.slice(0, 100).map((envelope) => {
        // The view reshapes (one keyword read as a list); the hash stays over the data as it arrived.
        const data = AtlasDataSchema.parse(envelope.data);
        const publicKey = envelope.author?.PublicKey ?? data.author?.PublicKey ?? "";
        const hash = Buffer.from(atlasHash(envelope.data, publicKey)).toString("hex");
        const url = webUrl(data.url);
        const type = RecordTypeSchema.safeParse(data["@type"]);
        return { nativeId: hash, nativeUrl: url, verification: verifyAtlas(envelope, publicKey) ? "signature-valid" : "signature-invalid", verifiedBy: "atlas-falcon1024", signingKey: publicKey || undefined, record: recordOf("atlas", {
            "@type": type.success ? type.data : "CreativeWork", headline: data.headline ?? data.name ?? "", text: data.text, articleBody: data.articleBody, url,
            datePublished: isoDate(data.datePublished), inLanguage: data.inLanguage,
            author: data.author ? { "@type": data.author["@type"] === "Organization" ? "Organization" : "Person", name: data.author.name ?? "", url: webUrl(data.author.url), identifier: data.author.identifier } : undefined,
            isBasedOn: [registry, hash], keywords: data.keywords ?? [], image: (data.image ?? []).filter((value) => webUrl(value)),
        }) };
    });
};
