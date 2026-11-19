// Rate-limit failures in the providers' own words, for the suites that tell a spent allowance from a throttle
// (limit-cause.ts) on each runtime. Each says where it came from: copied from this sandbox's daemon log or a transcript
// where one was met, written by hand only where none was, and then in the shape the vendor documents.

/** Words that show an allowance spent. */
export const SPENT_WORDS = {
    // Google's spent quota, as the gateway and OpenCode relay it (this sandbox's daemon log, 2026-11-10).
    google: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 93h2m4s.",
    // Codex's spent window on a team plan (this sandbox's daemon log, 2026-11-09).
    codex: "You’ve hit your usage limit. To get more access now, send a request to your admin or try again at 8:29 PM.",
    // The Claude CLI's sentence for a spent window, opening on one of the SDK's own USAGE_LIMIT_ERROR_PREFIXES
    // (title-namer.test.ts, from a transcript).
    claude: "You've hit your session limit · resets 11:50pm (UTC)",
    // Devin's, as its ACP loop says it (error-frames.test.ts, 2026-10-28).
    devin: "Your weekly usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.",
} as const;

/** Words that say only that requests were turned away: throttles, unless something else shows an allowance spent. */
export const THROTTLE_WORDS = {
    // Google slowing requests down, as the gateway hands it back (this sandbox's daemon log, 2026-11-16, six turns;
    // translator-gateway.test.ts THROTTLE).
    google: "Resource has been exhausted (e.g. check quota).",
    // Codex's give-up line on a 429 (error-frames.test.ts, from a transcript, 2026-10-20).
    codex: "exceeded retry limit, last status: 429 Too Many Requests",
    // The translator benching every credential of a model (error-frames.test.ts, from a transcript, 2026-10-20).
    translator: "All credentials for model claude-opus-4-6-thinking are cooling down via provider antigravity",
    // Hand-written: Anthropic's API 429 as the Claude CLI prints it, in the `rate_limit_error` body Anthropic documents,
    // since no turn here has met one to copy.
    anthropic:
        'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit for your organization of 450,000 input tokens per minute."}}',
} as const;
