import { z } from "zod";
import { BridgeItemSchema, RecordTypeSchema } from "./server/records.js";

export const SourceKindSchema = z.enum(["rss", "bluesky", "nostr", "atlas", "intentic"]);
export const AddSourceSchema = z.object({ kind: SourceKindSchema, address: z.string().trim().min(1).max(4096), label: z.string().trim().max(200).default(""), schemaType: RecordTypeSchema.default("Article") });
export const SourceSchema = AddSourceSchema.extend({ id: z.string(), enabled: z.boolean(), createdAt: z.number(), lastPollAt: z.number().nullable(), nextPollAt: z.number(), failures: z.number(), lastError: z.string().nullable(), etag: z.string().nullable(), lastModified: z.string().nullable() });
export type Source = z.infer<typeof SourceSchema>;
export const ItemSchema = BridgeItemSchema.extend({ id: z.string(), sourceId: z.string(), fetchedAt: z.number(), publishedAt: z.number().nullable(), score: z.number().nullable(), summary: z.string().nullable(), labels: z.array(z.string()), curatedAt: z.number().nullable() });
export type Item = z.infer<typeof ItemSchema>;
export const SearchSchema = z.object({ query: z.string().max(500).optional(), type: RecordTypeSchema.optional(), source: z.string().max(100).optional(), since: z.iso.datetime().optional(), limit: z.number().int().min(1).max(100).default(30), uncurated: z.boolean().optional() });
export type Search = z.infer<typeof SearchSchema>;
export const CurateSchema = z.object({ id: z.string().min(1).max(100), score: z.number().min(0).max(100), summary: z.string().max(2000), labels: z.array(z.string().trim().min(1).max(60)).max(12) });
export const SettingsSchema = z.object({
    curationRules: z.string().max(10000).default("Prefer original, useful sources. Summarize the substance, label the topic, and score relevance from 0 to 100."),
    pollMinutes: z.number().int().min(5).max(1440).default(30),
    retentionDays: z.number().int().min(1).max(3650).default(30),
    maxItems: z.number().int().min(100).max(100000).default(10000),
    nostrRelays: z.string().max(2000).default("wss://relay.damus.io\nwss://nos.lol"),
    // Start a curator run by itself after a poll that brought new items; off, only a press starts one.
    autoCurate: z.boolean().default(false),
    // How many rounds of 50 items one curator run reads at most.
    curateBatches: z.number().int().min(1).max(20).default(4),
    // Whether approving a publication needs a passkey; off, a passkey is offered and a plain yes also publishes.
    requirePasskey: z.boolean().default(false),
    // The author name this sandbox's publications carry; empty, the sandbox's own name.
    authorName: z.string().max(200).default(``),
    // What the catalog says this log is about, comma-separated; and its languages.
    catalogKeywords: z.string().max(1000).default(``),
    catalogLanguages: z.string().max(200).default(``),
    // Other sandboxes this one asks to cosign the checkpoints it reads, and whose catalogs it searches: addresses, one a line.
    witnesses: z.string().max(4000).default(``),
    guides: z.string().max(4000).default(``),
    // Attestation issuers this reader trusts, by key fingerprint (isk1:…), one a line: their vouches lift a peer to L3.
    trustedIssuers: z.string().max(8000).default(``),
    // What this sandbox does for others: cosign their checkpoints, mirror the logs it follows, answer guide searches.
    witnessMode: z.boolean().default(false),
    mirrorMode: z.boolean().default(false),
    guideMode: z.boolean().default(false),
});
export type Settings = z.infer<typeof SettingsSchema>;
// This sandbox's own log, as the Published tab shows it.
export const PublishingSchema = z.object({
    size: z.number().int().min(0),
    // Where anyone reads and verifies it; absent when the daemon names no identity (one from before 2.60.0).
    catalogUrl: z.string().optional(),
    published: z.array(z.object({ seq: z.number(), type: z.string().nullable(), headline: z.string().nullable(), publishedAt: z.string(), tombstoneOf: z.number().nullable(), withdrawn: z.boolean(), cosigned: z.boolean() })),
    waiting: z.array(z.object({ id: z.string(), kind: z.enum([`publish`, `withdraw`]), headline: z.string(), createdAt: z.number(), cosign: z.enum([`offered`, `required`]) })),
});
export type Publishing = z.infer<typeof PublishingSchema>;
export const PublishRequestSchema = z.object({
    type: z.enum([`SocialMediaPosting`, `Article`, `BlogPosting`]).default(`SocialMediaPosting`),
    headline: z.string().trim().max(300).optional(),
    text: z.string().trim().min(1).max(20_000),
    keywords: z.array(z.string().trim().min(1).max(60)).max(12).default([]),
});
// A followed sandbox, as the Peers tab shows it (peers/peer-view.ts).
export const PeerViewSchema = z.object({
    sourceId: z.string(),
    address: z.string(),
    name: z.string(),
    fingerprint: z.string(),
    state: z.enum([`ok`, `held`, `equivocation`]),
    problem: z.string().nullable(),
    domainVerified: z.boolean(),
    passkeyShare: z.number(),
    vouches: z.array(z.object({ issuer: z.string(), trusted: z.boolean(), claims: z.record(z.string(), z.string()) })),
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    declared: z.number(),
    verified: z.number(),
    witnessed: z.number(),
    witnesses: z.number(),
    hasEvidence: z.boolean(),
    syncedAt: z.number().nullable(),
});
export type PeerView = z.infer<typeof PeerViewSchema>;
export const DiscoverHitSchema = z.object({ address: z.string(), name: z.string(), types: z.array(z.string()), keywords: z.array(z.string()), languages: z.array(z.string()), via: z.string() });
export type DiscoverHitView = z.infer<typeof DiscoverHitSchema>;
export const SnapshotSchema = z.object({
    sources: z.array(SourceSchema),
    items: z.array(ItemSchema),
    settings: SettingsSchema,
    // Whether the reader may change sources and start runs (a maintainer or the owner, or nobody signed in).
    canWrite: z.boolean(),
    uncurated: z.number().int().min(0),
    publishing: PublishingSchema,
    peers: z.array(PeerViewSchema),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
export const SourceToggleSchema = z.object({ enabled: z.boolean() });
export const RefreshSchema = z.object({ source: z.string().max(100).optional() });
export const routes = { snapshot: "/snapshot", refresh: "/refresh", sources: "/sources", curate: "/curate", publish: "/publish", withdraw: "/withdraw", peers: "/peers", discover: "/discover" } as const;
