// Shared parsing vocabulary for undocumented provider payloads (Anthropic, ChatGPT, Google, Kimi all use private,
// unpublished endpoints). A malformed field must cost a ring, never an exception, by the same rule on every provider,
// so two meters never disagree about what counts as unreadable.

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

// ISO-8601 reset instant to epoch seconds, the wire's unit for Anthropic/Google/Kimi (Codex sends numbers, see
// resetSeconds in translator-usage.ts); one parse so an unreadable instant drops the same way everywhere.
export const resetFromIso = (value: unknown): number | undefined => {
    const parsed = Date.parse(asString(value) ?? "");
    return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
};
