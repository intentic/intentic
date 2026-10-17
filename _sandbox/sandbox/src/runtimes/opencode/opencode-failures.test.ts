import { opt } from "../../opt.js";
import { OPENCODE_GEMINI_PROVIDER } from "../gemini/gemini-models.js";
import { executionErrorFrame, OUTAGE_ATTEMPTS, RATE_LIMIT_PATIENCE_MS, retryFrame, retryHandover, type StructuredError } from "./opencode-failures.js";
import { OPENCODE_XAI_PROVIDER } from "./xai-models.js";

// How an OpenCode turn's failures are coded: OpenCode 2's own failure types first (the types its 2.0.26 build gives a
// provider's answer), the sentence only where the type says nothing more.

const GOOGLE = { provider: OPENCODE_GEMINI_PROVIDER, model: "gemini-pro-agent" };
const GROK = { provider: OPENCODE_XAI_PROVIDER, model: "grok-4" };
const failure = (type: string, message: string, status?: number): StructuredError => ({ type, message, ...opt("status", status) });

describe("an execution's failure", () => {
    test.each([
        ["provider.rate-limit", "Too many requests", undefined, "rate_limit"],
        ["provider.quota", "You have used up your allowance", undefined, "rate_limit"],
        ["provider.transport", "ConnectionRefused: Unable to connect.", undefined, "provider-outage"],
        ["provider.internal", "No capacity available for model gemini-pro-agent", 503, "provider-outage"],
        ["provider.timeout", "The request timed out", undefined, "provider-outage"],
        // A 5xx is the provider's trouble whatever OpenCode called it, and a 429 is a limit.
        ["provider.invalid-output", "Bad gateway", 502, "provider-outage"],
        ["unknown", "slow down", 429, "rate_limit"],
    ] as const)("typed %s is coded %#", (type, message, status, code) => {
        expect(executionErrorFrame(failure(type, message, status), GOOGLE)).toEqual({ kind: "error", code, message });
    });

    test("a model OpenCode cannot route is off the picker on Google, and reloads xAI's catalog on Grok", () => {
        const unroutable = failure("provider.no-route", "Model unavailable: intentic-gemini/gemini-pro-agent");

        expect(executionErrorFrame(unroutable, GOOGLE)).toMatchObject({ kind: "error", code: "model-unavailable" });
        expect(executionErrorFrame(unroutable, GOOGLE).message).toContain("gemini-pro-agent");
        expect(executionErrorFrame(unroutable, GROK)).toEqual({ kind: "error", code: "grok-model-invalid", message: unroutable.message });
    });

    // An overflow is an invalid request to most providers: read before the type, so it is re-run fresh rather than held.
    test("a session past the model's window is coded context-overflow whatever type it came under", () => {
        const overflow = failure("provider.invalid-request", "prompt is too long: 210000 tokens > 200000 maximum");

        expect(executionErrorFrame(overflow, GOOGLE)).toEqual({ kind: "error", code: "context-overflow", message: overflow.message });
    });

    test("a type that says nothing more falls back on the sentence, and a sentence that says nothing stays uncoded", () => {
        expect(executionErrorFrame(failure("unknown", "Rate limit exceeded, retry later"), GOOGLE)).toMatchObject({ code: "rate_limit" });
        expect(executionErrorFrame(failure("unknown", "Model not found: grok-9. Did you mean grok-4?"), GROK)).toMatchObject({ code: "grok-model-invalid" });
        expect(executionErrorFrame(failure("tool.execution", "The edit did not apply"), GOOGLE)).toEqual({ kind: "error", message: "The edit did not apply" });
    });
});

describe("a retry OpenCode scheduled", () => {
    const NOW = 1_000_000;
    const CAP_LEFT = 20 * 60_000;
    const retry = (error: StructuredError, attempt: number, waitMs: number) => ({ error, attempt, at: NOW + waitMs });

    test("a short rate limit and an outage's first tries are OpenCode's to wait out", () => {
        expect(retryHandover(retry(failure("provider.rate-limit", "slow down", 429), 2, 30_000), CAP_LEFT, NOW)).toBeUndefined();
        expect(retryHandover(retry(failure("provider.internal", "No capacity", 503), OUTAGE_ATTEMPTS - 1, 4_000), CAP_LEFT, NOW)).toBeUndefined();
    });

    test("a spent quota is handed over at once, with the reset OpenCode named", () => {
        expect(retryHandover(retry(failure("provider.quota", "quota exceeded"), 2, 5_000), CAP_LEFT, NOW)).toEqual({
            kind: "error",
            code: "rate_limit",
            message: "quota exceeded",
            resetsAt: Math.ceil((NOW + 5_000) / 1_000),
        });
    });

    // 2026-10-17: Google said "Resets in 166h40m39s" and the turn was booked fifteen minutes out, at OpenCode's capped
    // retry, and refused again.
    test("a quota whose vendor names its own reset is handed over at that reset, not at OpenCode's capped retry", () => {
        const said = "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 166h40m39s.";
        expect(retryHandover(retry(failure("provider.quota", said, 429), 2, 15 * 60_000), CAP_LEFT, NOW)).toMatchObject({
            code: "rate_limit",
            resetsAt: Math.ceil(NOW / 1_000 + 166 * 3_600 + 40 * 60 + 39),
        });
    });

    test("a rate limit whose wait outlasts the turn's patience is handed over with its reset", () => {
        expect(retryHandover(retry(failure("provider.rate-limit", "slow down", 429), 2, RATE_LIMIT_PATIENCE_MS + 1_000), CAP_LEFT, NOW)).toMatchObject({
            code: "rate_limit",
            resetsAt: Math.ceil((NOW + RATE_LIMIT_PATIENCE_MS + 1_000) / 1_000),
        });
    });

    test("an outage that keeps failing is handed to the daemon's backoff", () => {
        expect(retryHandover(retry(failure("provider.internal", "No capacity", 503), OUTAGE_ATTEMPTS, 8_000), CAP_LEFT, NOW)).toEqual({
            kind: "error",
            code: "provider-outage",
            message: "No capacity",
        });
    });

    // The turn would end on its cap before the retry came: waiting for it only turns a resumable failure into a timeout.
    test("any retry falling past what is left of the turn's cap is handed over", () => {
        expect(retryHandover(retry(failure("provider.transport", "socket hang up"), 2, 60_000), 30_000, NOW)).toMatchObject({ code: "provider-outage" });
        expect(retryHandover(retry(failure("provider.rate-limit", "slow down", 429), 2, 60_000), 30_000, NOW)).toMatchObject({ code: "rate_limit" });
    });

    test("is shown as a wait, a rate limit by its status", () => {
        expect(retryFrame({ attempt: 2, at: 5, error: failure("provider.rate-limit", "slow down") })).toEqual({ kind: "provider_retry", attempt: 2, nextAttemptAt: 5, status: 429 });
        expect(retryFrame({ attempt: 3, at: 9, error: failure("provider.transport", "socket hang up") })).toEqual({ kind: "provider_retry", attempt: 3, nextAttemptAt: 9 });
    });
});
