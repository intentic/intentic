import { z } from "zod";

export const WebUrlSchema = z.url().max(4096).refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
}, "Expected an HTTP(S) URL without credentials");
export const RecordTypeSchema = z.enum(["SocialMediaPosting", "Article", "BlogPosting", "Comment", "CreativeWork"]);
const AuthorSchema = z.object({
    "@type": z.enum(["Person", "Organization"]),
    name: z.string().max(500),
    url: WebUrlSchema.optional(),
    identifier: z.string().max(4096).optional(),
});
export const RecordSchema = z.object({
    "@context": z.literal("https://schema.org"),
    "@type": RecordTypeSchema,
    headline: z.string().max(1000),
    text: z.string().max(100000).optional(),
    articleBody: z.string().max(100000).optional(),
    url: WebUrlSchema.optional(),
    datePublished: z.iso.datetime().optional(),
    author: AuthorSchema.optional(),
    sdPublisher: z.object({ "@type": z.literal("SoftwareApplication"), name: z.string().max(100) }),
    isBasedOn: z.array(z.string().max(4096)).min(1).max(10),
    inLanguage: z.string().max(100).optional(),
    keywords: z.array(z.string().max(100)).max(50).default([]),
    image: z.array(WebUrlSchema).max(10).default([]),
});
export type NetworkRecord = z.infer<typeof RecordSchema>;
const VerificationSchema = z.enum(["unsigned", "signature-valid", "signature-invalid"]);
export const BridgeItemSchema = z.object({
    nativeId: z.string().min(1).max(4096),
    nativeUrl: WebUrlSchema.optional(),
    record: RecordSchema,
    verification: VerificationSchema,
    verifiedBy: z.enum(["nostr-schnorr", "atlas-falcon1024", "intentic-log"]).optional(),
    // The signed author's identifier belongs to the proof, distinct from the record's claimed display author.
    signingKey: z.string().max(4096).optional(),
});
export type BridgeItem = z.infer<typeof BridgeItemSchema>;
