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

// Longest a provider's refusal can be and still be printed beside a meter; past it the sentence is a pasted payload.
const FAILURE_MAX_CHARS = 120;

// Why a quota read was refused, in the provider's own sentence where its error body has one (Google, OpenAI and
// Anthropic all nest it at `error.message`; some answer `detail` or `message` at the top), else the bare status. The
// words are the point: "Verify your account to continue." tells a reader what to do, and "HTTP 403" does not.
export const readFailure = (status: number, body: string | undefined): string => {
    const parsed = ((): unknown => {
        try {
            return JSON.parse(body ?? "") as unknown;
        } catch {
            // silent-catch: a body that is not JSON has no sentence to lift, and the status below still says what failed.
            return undefined;
        }
    })();
    const record = asRecord(parsed);
    const words = asString(asRecord(record?.[`error`])?.[`message`]) ?? asString(record?.[`error`]) ?? asString(record?.[`detail`]) ?? asString(record?.[`message`]);
    const line = words?.split("\n")[0]?.trim();
    return line === undefined || line === "" || line.length > FAILURE_MAX_CHARS ? `HTTP ${String(status)}` : line;
};
