import type { AgentEvent } from "@intentic/sandbox-contract";

// How long a provider's prompt cache stays warm. No provider publishes an expiry anywhere in a response, so the answer
// is either measured off the response or quoted from the harness that asked for it; a provider with neither answers
// undefined, since a guessed deadline reads exactly like a known one on a card.

// Anthropic's two TTLs. A cache read refreshes the entry as cheaply as a write does, so the clock always runs from the
// last request against the prefix rather than from the one that created it.
export const PROMPT_CACHE_5M_MS = 5 * 60 * 1_000;
export const PROMPT_CACHE_1H_MS = 60 * 60 * 1_000;

// `usage.cache_creation` as the Messages API returns it: the request's cache write, split by the TTL it went in under.
export interface CacheCreationBuckets {
    readonly ephemeral_5m_input_tokens?: number | null;
    readonly ephemeral_1h_input_tokens?: number | null;
}

// Measured, not inferred: a non-zero bucket names the TTL the harness actually asked for. Undefined when the request
// wrote nothing, which says "no write this request", never "no cache" — the caller keeps the last answer instead.
// The longer bucket wins a request that wrote both: the short one is the extra write a server tool inserts after its
// results, not the conversation's own breakpoints, which are what a follow-up turn reads back.
export const ttlFromCacheCreation = (buckets: CacheCreationBuckets | undefined): number | undefined => {
    if ((buckets?.ephemeral_1h_input_tokens ?? 0) > 0) {
        return PROMPT_CACHE_1H_MS;
    }
    return (buckets?.ephemeral_5m_input_tokens ?? 0) > 0 ? PROMPT_CACHE_5M_MS : undefined;
};

// The fallback for a turn that read cache without writing any: Claude Code's own rule, quoted from the CLI this daemon
// spawns — CLAUDE_CODE_PROMPT_CACHE_TTL is "5m" or "1h", and unset is "1 hour on a Claude subscription within its usage
// limits, 5 minutes on an API key, Bedrock, Vertex or Foundry". Optimistic in the one corner the CLI can see and we
// cannot (a subscription past its usage limits writes 5m entries), which any later measured bucket corrects.
// `claude` is the only provider Anthropic itself serves: a translator or minted endpoint wears an Anthropic-shaped API
// over its own vendor's cache, whose lifetime nobody publishes.
export const ttlFromCredential = (provider: string, oauth: boolean): number | undefined =>
    provider !== "claude" ? undefined : oauth ? PROMPT_CACHE_1H_MS : PROMPT_CACHE_5M_MS;

type ContextUsageFrame = Extract<AgentEvent, { kind: "context_usage" }>;

// Finishes a frame the runtime could only half-fill. The pair travels whole or not at all: an instant with no lifetime
// names no deadline, so a provider whose rule nobody publishes loses the instant along with the TTL it never had.
export const withCacheTtl = (frame: ContextUsageFrame, provider: string, oauth: boolean): ContextUsageFrame => {
    if (frame.cachedAt === undefined || frame.cacheTtlMs !== undefined) {
        return frame;
    }
    const ttlMs = ttlFromCredential(provider, oauth);
    if (ttlMs !== undefined) {
        return { ...frame, cacheTtlMs: ttlMs };
    }
    const { cachedAt: _cachedAt, ...grounded } = frame;
    return grounded;
};
