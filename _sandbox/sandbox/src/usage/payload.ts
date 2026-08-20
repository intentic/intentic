/* READING AN UNDOCUMENTED PROVIDER PAYLOAD, the vocabulary every plan-limit reader in this directory parses
 * with, and the reason they agree about what "unreadable" means.
 *
 * None of the endpoints behind these readers is a published contract: Anthropic's OAuth usage route, ChatGPT's
 * wham/usage, Google's quota summary and Kimi's coding usages are all private doors the vendors' own clients
 * knock on. So a field that changes name, casing or type must cost a ring and never an exception, and it has
 * to cost the SAME ring on every provider, which is what these shared helpers are for. A reset instant dropped
 * by one reader's rule and kept by another's would make two meters on the same screen disagree about whether
 * the same malformed timestamp is a timestamp. */

export const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

export const asNumber = (value: unknown): number | undefined => {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value !== "string" || value.trim() === "") {
        return undefined;
    }
    const parsed = Number(value.endsWith("%") ? value.slice(0, -1) : value);
    return Number.isFinite(parsed) ? parsed : undefined;
};

export const asString = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

export const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

// An ISO-8601 reset instant as the epoch SECONDS the wire carries. Anthropic, Google and Kimi all name their
// resets this way (Codex sends numbers, hence resetSeconds in translator-usage.ts), one parse, so an unreadable
// instant is dropped by the same rule on all of them rather than by copies that could disagree.
export const resetFromIso = (value: unknown): number | undefined => {
    const parsed = Date.parse(asString(value) ?? "");
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
};
