// keep-warm: holding an idle conversation's prompt cache open by re-reading it shortly before it expires.

import { z } from "zod";

const HOUR_MS = 3_600_000;

// Anthropic's price multipliers on base input: a read costs 0.1x, a write 2x under the 1h TTL and 1.25x under 5m.
const READ_COST = 0.1;
const writeCost = (ttlMs: number): number => (ttlMs >= HOUR_MS ? 2 : 1.25);

// A cache clock as the daemon publishes it: the last request that touched the entry, and the entry's lifetime.
export interface CacheClock {
    readonly at: number;
    readonly ttlMs: number;
}

/** How long before expiry a refresh starts: a fifth of the entry's life, never under a minute or over ten. */
export const keepWarmLeadMs = (ttlMs: number): number => Math.min(10 * 60_000, Math.max(60_000, Math.round(ttlMs / 5)));

/** Refreshes one hold may spend: half of what a cold resume rewrites, the other half left for each refresh's own tail. */
export const keepWarmMaxRefreshes = (ttlMs: number): number => Math.floor((writeCost(ttlMs) - READ_COST) / READ_COST / 2);

/** How many refreshes keep an entry alive through `until`. */
export const keepWarmRefreshes = (cache: CacheClock, until: number): number => {
    const beyond = until - (cache.at + cache.ttlMs);
    return beyond <= 0 ? 0 : Math.ceil(beyond / (cache.ttlMs - keepWarmLeadMs(cache.ttlMs)));
};

/** The latest instant a hold may reach, given the refreshes it already spent: past it, refreshing costs more than the cold resume it saves. */
export const keepWarmHorizon = (cache: CacheClock, spent = 0): number =>
    cache.at + cache.ttlMs + Math.max(0, keepWarmMaxRefreshes(cache.ttlMs) - spent) * (cache.ttlMs - keepWarmLeadMs(cache.ttlMs));

/** When the next refresh is due for an entry last touched at `cache.at`. */
export const keepWarmDueAt = (cache: CacheClock): number => cache.at + cache.ttlMs - keepWarmLeadMs(cache.ttlMs);

/** The furthest `until` a hold can honestly promise: the economic horizon, or the date change, whichever comes first. */
export const keepWarmCap = (cache: CacheClock, rollsAt: number | undefined, spent = 0): number =>
    rollsAt === undefined ? keepWarmHorizon(cache, spent) : Math.min(keepWarmHorizon(cache, spent), rollsAt);

// Why a hold ended before anyone picked the conversation up. `elapsed` is the one ending that is not a problem.
export const KeepWarmEndSchema = z.enum(["elapsed", "allowance", "limited", "changed", "rewrote", "cold", "failed", "midnight", "moved"]);
export type KeepWarmEnd = z.infer<typeof KeepWarmEndSchema>;

export const KeepWarmSchema = z.object({
    since: z.number().describe("When keeping it warm started, in milliseconds."),
    until: z
        .number()
        .describe(
            "When it stops by itself, in milliseconds: the time asked for, shortened to what the sandbox can honestly keep, which is never past the point where refreshing costs more than re-reading, nor past the date change that rewrites the prompt.",
        ),
    auto: z.boolean().optional().describe("Started by the sandbox-wide setting after a turn, rather than by a press on this conversation."),
    refreshes: z.number().int().min(0).describe("Refreshes sent so far."),
    readTokens: z
        .number()
        .optional()
        .describe("How much the last refresh read back from the provider's cache, in tokens: the proof the cache was still there."),
    ended: z
        .object({
            at: z.number().describe("When it stopped, in milliseconds."),
            reason: KeepWarmEndSchema.describe(
                "Why: `elapsed` the time asked for ran out; `allowance` the account reached the reserve kept for real work; `limited` the provider refused a refresh; `changed` what the next turn would send no longer matches the cache; `rewrote` a refresh found the cache already gone; `cold` it expired before a refresh could run; `failed` a refresh failed; `midnight` the date in the prompt changed; `moved` the conversation's session or account changed.",
            ),
            detail: z.string().optional().describe("The specifics, when there are any: which parts of the prompt changed, or the failure's own words."),
        })
        .optional()
        .describe("Why keeping it warm stopped before anyone picked the conversation up. Absent while it is still being kept."),
});
export type KeepWarm = z.infer<typeof KeepWarmSchema>;

export const AgentKeepWarmSchema = z.object({
    id: z.string().min(1).describe("Which conversation."),
    until: z
        .number()
        .nullable()
        .describe(
            "Keep its prompt cache warm until this instant, in milliseconds; shortened to what the sandbox can honestly keep. Null stops keeping it warm.",
        ),
});
export type AgentKeepWarm = z.infer<typeof AgentKeepWarmSchema>;

// What a turn's first request found in the cache, and how long it had been kept warm for it when it was.
export const PromptCacheOpeningSchema = z.object({
    readTokens: z.number().describe("Tokens the turn's first request read from the provider's cache."),
    writtenTokens: z.number().describe("Tokens it wrote to the cache, which is what it paid full price for."),
    kept: z
        .object({
            forMs: z.number().describe("How long the cache had been kept warm for this turn, in milliseconds."),
            refreshes: z.number().int().min(0).describe("How many refreshes that took."),
        })
        .optional()
        .describe("Present when this turn picked up a conversation the sandbox had been keeping warm."),
});
export type PromptCacheOpening = z.infer<typeof PromptCacheOpeningSchema>;

const tokensLabel = (tokens: number): string => (tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : String(tokens));

const spanLabel = (ms: number): string => {
    const minutes = Math.max(1, Math.round(ms / 60_000));
    const hours = Math.floor(minutes / 60);
    return hours === 0 ? `${minutes}m` : `${hours}h ${minutes % 60}m`;
};

/** The transcript's line for a turn that picked up a conversation kept warm for it; undefined for any other turn. */
export const keptWarmLine = (opening: PromptCacheOpening): string | undefined => {
    const { kept } = opening;
    if (kept === undefined) {
        return undefined;
    }
    const held = `kept warm for ${spanLabel(kept.forMs)} with ${kept.refreshes} ${kept.refreshes === 1 ? "refresh" : "refreshes"}`;
    return opening.readTokens >= opening.writtenTokens
        ? `Picked up warm: ${tokensLabel(opening.readTokens)} tokens read from the cache, ${held}.`
        : `Picked up cold despite being ${held}: ${tokensLabel(opening.writtenTokens)} tokens sent again, because this turn's prompt no longer matched the cache.`;
};

// A turn's prefix, part by part, so two turns that should share a cache can say which part stopped matching.
export const PromptFingerprintSchema = z.object({
    hash: z.string().describe("One short hash over every part."),
    parts: z.record(z.string(), z.string()).describe("Each part's own short hash or value, by name."),
});
export type PromptFingerprint = z.infer<typeof PromptFingerprintSchema>;

/** Which parts differ between two fingerprints, by name; empty when they match. */
export const changedParts = (before: PromptFingerprint, after: PromptFingerprint): string[] =>
    [...new Set([...Object.keys(before.parts), ...Object.keys(after.parts)])].filter((name) => before.parts[name] !== after.parts[name]).toSorted();
