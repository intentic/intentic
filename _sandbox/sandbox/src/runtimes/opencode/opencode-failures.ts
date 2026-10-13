import type { AgentEvent } from "@intentic/sandbox-contract";
import { isContextOverflowText } from "../../agent/providers/failure-sentences.js";
import { modelUnavailableFrame } from "../../agent/run/error-frames.js";
import { opt } from "../../opt.js";
import { isRateLimited, vendorFailureFrame, type VendorRule } from "../decorators/vendor-errors.js";
import { OPENCODE_XAI_PROVIDER } from "./xai-models.js";

// How an OpenCode turn's failures are coded. OpenCode 2 types every provider failure it ends an execution or schedules a
// retry over (`SessionStructuredError.type`, its own classification of the provider's answer, checked against 2.0.26):
// the codes the daemon's hold and auto-resume key off are read from that type first, and from the sentence only where
// the type says nothing more than `unknown`.

type ErrorFrame = Extract<AgentEvent, { kind: "error" }>;

// One provider failure as OpenCode reports it; `response.body` is the provider's own answer, where it gave one.
export interface StructuredError {
    readonly type: string;
    readonly message: string;
    readonly status?: number;
    readonly response?: { readonly body: string };
}

// A structured error's whole text: its sentence and, where the provider answered, the body it answered with, which is
// where xAI names its valid models.
export const errorDetail = (error: StructuredError): string => (error.response === undefined ? error.message : `${error.message} ${error.response.body}`);

// xAI surfaces an unknown/retired model id as a "model not found" error naming valid alternatives; OpenCode itself says
// "Model unavailable" for one it cannot route at all. Tagged so the client reloads the catalog and drops the bad pinned
// model.
export const MODEL_INVALID = /model not found|does not exist|no such model|did you mean|model unavailable/i;

// What a failure is, for the daemon: a spent allowance waits for its reset, a provider having a bad time is re-run on
// backoff, a session past its window is re-run fresh, and a model the route cannot reach is taken off the picker.
type FailureKind = "rate-limit" | "outage" | "no-route" | undefined;

// OpenCode's types (2.0.26 `SessionExecution` → `provider.*`), each read as what the daemon can do about it.
const KIND_OF_TYPE = new Map<string, FailureKind>([
    ["provider.rate-limit", "rate-limit"],
    ["provider.quota", "rate-limit"],
    ["provider.transport", "outage"],
    ["provider.internal", "outage"],
    ["provider.timeout", "outage"],
    ["provider.no-route", "no-route"],
]);

// A 5xx is the provider's own trouble whatever OpenCode called it; a 429 is a limit.
const kindOf = (error: StructuredError): FailureKind => {
    const typed = KIND_OF_TYPE.get(error.type);
    if (typed !== undefined) {
        return typed;
    }
    if (error.status === 429) {
        return "rate-limit";
    }
    return error.status !== undefined && error.status >= 500 ? "outage" : undefined;
};

// What a turn's failure is coded against: the backend it ran on and the model it asked for.
export interface FailureTarget {
    readonly provider: string;
    readonly model: string | undefined;
}

// The sentence rules, read only where the type said nothing the daemon can act on: a model xAI rejected, then a spent
// allowance (a retry-later notice instead of a Continue that would just re-fail), then a session past the model's window.
const SENTENCE_RULES: readonly VendorRule[] = [
    [(message) => MODEL_INVALID.test(message), "grok-model-invalid"],
    [isRateLimited, "rate_limit"],
    [isContextOverflowText, "context-overflow"],
];

const typedFrame = (error: StructuredError, kind: FailureKind, target: FailureTarget): ErrorFrame | undefined => {
    switch (kind) {
        case "rate-limit":
            return { kind: "error", code: "rate_limit", message: error.message };
        case "outage":
            return { kind: "error", code: "provider-outage", message: error.message };
        case "no-route":
            // xAI's own rejection of a retired id keeps its catalog-reloading code; any other model the server cannot
            // route is off the picker until it can.
            if (target.provider === OPENCODE_XAI_PROVIDER || target.model === undefined || target.model === "") {
                return { kind: "error", code: "grok-model-invalid", message: error.message };
            }
            return modelUnavailableFrame(target.model, `OpenCode could not reach ${target.model} ("${error.message}").`);
        case undefined:
            return undefined;
    }
};

/**
 * An execution's failure as its frame. A parameter this sandbox never sent is read first (vendorFailureFrame), then a
 * session past its window, whatever type it came under (an overflow is an invalid request to most providers), then
 * OpenCode's own type, and the sentence last.
 */
export const executionErrorFrame = (error: StructuredError, target: FailureTarget): ErrorFrame => {
    const plain: ErrorFrame = { kind: "error", message: error.message };
    const read = vendorFailureFrame(plain, []);
    if (read.code !== undefined) {
        return read;
    }
    if (isContextOverflowText(error.message)) {
        return { ...plain, code: "context-overflow" };
    }
    return typedFrame(error, kindOf(error), target) ?? vendorFailureFrame(plain, SENTENCE_RULES);
};

// How long a rate limit OpenCode means to wait out in-turn is left to it: past this, the turn hands the wait to the
// daemon, which holds the conversation and resumes it at the reset (classify-failure.ts) instead of keeping a turn open
// on nothing. OpenCode honours a provider's retry-after of up to 15 minutes.
export const RATE_LIMIT_PATIENCE_MS = 2 * 60_000;

// How many attempts OpenCode makes at a provider having a bad time before the turn hands it to the daemon's backoff;
// its own first attempt is 1, its first retry 2. OpenCode alone would try ten times, the last ones minutes apart.
export const OUTAGE_ATTEMPTS = 4;

export interface ScheduledRetry {
    readonly attempt: number;
    // When OpenCode means to try again, epoch ms.
    readonly at: number;
    readonly error: StructuredError;
}

/**
 * Whether a retry OpenCode scheduled should be left to it, or handed to the daemon as the coded failure the hold and
 * auto-resume read: undefined lets it run. A retry falling past what is left of the turn's cap is handed over whatever
 * it is, since the turn would end before it came; a spent quota at once, since waiting in-turn cannot refill it; a rate
 * limit whose wait outlasts RATE_LIMIT_PATIENCE_MS with its reset named; an outage once OUTAGE_ATTEMPTS have failed.
 */
export const retryHandover = (retry: ScheduledRetry, capRemainingMs: number, now = Date.now()): ErrorFrame | undefined => {
    const kind = kindOf(retry.error) ?? (isRateLimited(retry.error.message) ? "rate-limit" : "outage");
    const wait = retry.at - now;
    const pastCap = wait >= capRemainingMs;
    if (kind === "rate-limit") {
        const resetsAt = Math.ceil(retry.at / 1_000);
        const handed = pastCap || retry.error.type === "provider.quota" || wait > RATE_LIMIT_PATIENCE_MS;
        return handed ? { kind: "error", code: "rate_limit", message: retry.error.message, ...opt("resetsAt", resetsAt) } : undefined;
    }
    if (kind === "no-route") {
        return undefined;
    }
    return pastCap || retry.attempt >= OUTAGE_ATTEMPTS ? { kind: "error", code: "provider-outage", message: retry.error.message } : undefined;
};

// An in-turn provider retry, so the chat shows a wait rather than an apparent hang; `status: 429` lets the UI say it is
// rate-limiting rather than a dead turn. No maxAttempts: OpenCode names none, so none is invented.
const limited = (error: StructuredError): boolean => error.status === 429 || kindOf(error) === "rate-limit" || isRateLimited(error.message);

export const retryFrame = (retry: ScheduledRetry): AgentEvent => ({
    kind: "provider_retry",
    attempt: retry.attempt,
    nextAttemptAt: retry.at,
    ...opt("status", limited(retry.error) ? 429 : undefined),
});
