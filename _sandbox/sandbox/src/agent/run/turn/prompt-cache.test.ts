import { test, expect } from "bun:test";
import { PROMPT_CACHE_1H_MS, PROMPT_CACHE_5M_MS, ttlFromCacheCreation, ttlFromCredential, withCacheTtl } from "./prompt-cache.js";

type ContextFrame = Parameters<typeof withCacheTtl>[0];

const frame = (over: Partial<ContextFrame> = {}): ContextFrame => ({
    kind: "context_usage",
    tokens: 142_000,
    contextWindow: 200_000,
    ...over,
});

// The one reading that is a measurement rather than a rule: the bucket a write went in under names the lifetime the
// harness asked for, which this daemon never sees it ask for.
test("a cache write's bucket names its own lifetime", () => {
    expect(ttlFromCacheCreation({ ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 })).toBe(PROMPT_CACHE_1H_MS);
    expect(ttlFromCacheCreation({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 2000 })).toBe(PROMPT_CACHE_5M_MS);
});

// A request that wrote nothing still read from an entry that exists; answering 5m here would cut an hour's cache short
// on the first turn that only read.
test("a request that wrote nothing names no lifetime, rather than the shorter one", () => {
    expect(ttlFromCacheCreation({ ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 })).toBeUndefined();
    expect(ttlFromCacheCreation(undefined)).toBeUndefined();
});

// A server tool inserts its own 5-minute write after its results even in an hour-long session, so both buckets filled
// is one conversation's hour plus one tool's five minutes, not a five-minute conversation.
test("the longer lifetime wins a request that wrote both", () => {
    expect(ttlFromCacheCreation({ ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 500 })).toBe(PROMPT_CACHE_1H_MS);
});

// Claude Code's documented automatic rule, which is the only thing standing behind a turn that read without writing.
test("the credential's own rule answers for Claude, and for nobody else", () => {
    expect(ttlFromCredential("claude", true)).toBe(PROMPT_CACHE_1H_MS);
    expect(ttlFromCredential("claude", false)).toBe(PROMPT_CACHE_5M_MS);
    // Anthropic-shaped endpoints serving someone else's model: the API is borrowed, the cache is theirs, and nobody
    // publishes its lifetime.
    expect(ttlFromCredential("codex", true)).toBeUndefined();
    expect(ttlFromCredential("grok", true)).toBeUndefined();
});

test("a measured lifetime is never overwritten by the rule", () => {
    const measured = frame({ cachedAt: 1_700_000_000_000, cacheTtlMs: PROMPT_CACHE_5M_MS });
    // A 5m bucket on a subscription turn is the truth about that write; the rule's optimistic hour must not replace it.
    expect(withCacheTtl(measured, "claude", true)).toEqual(measured);
});

test("the rule finishes a frame carrying only the instant", () => {
    expect(withCacheTtl(frame({ cachedAt: 1_700_000_000_000 }), "claude", true)).toEqual(
        frame({ cachedAt: 1_700_000_000_000, cacheTtlMs: PROMPT_CACHE_1H_MS }),
    );
});

// Half a pair names no deadline. Leaving the instant on the wire would let a reader pair it with a lifetime of its own
// invention, which is the one thing this whole path exists to avoid.
test("an instant nobody can put a lifetime to is dropped with it", () => {
    expect(withCacheTtl(frame({ cachedAt: 1_700_000_000_000 }), "codex", true)).toEqual(frame());
});

test("a frame with no instant is left exactly as it came", () => {
    expect(withCacheTtl(frame(), "claude", true)).toEqual(frame());
});
