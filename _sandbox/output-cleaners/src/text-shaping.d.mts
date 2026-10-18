// Types for text-shaping.mjs: the generic stages applied to an MCP tool's text, which has no command to classify.

// Dedup, wide-run cut and a head/tail cap within the named budgets, keeping diagnostic lines from the cut middle.
export const cleanToolText: (
    text: string,
    limits?: { chars?: number; lines?: number; head?: number; tail?: number; enabled?: ReadonlySet<string> },
) => string;
