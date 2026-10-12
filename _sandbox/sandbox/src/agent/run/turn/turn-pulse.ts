import type { AgentEvent } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { createRepeatGate } from "../../../logs/repeat-gate.js";
import { opt } from "../../../opt.js";
import { ANSWERED_FRAMES } from "../frames/frame-reducers.js";

// What a running turn last showed of itself, per conversation: which turn and run it is, when its runtime last said
// anything, and the upstream retry it is riding out. A turn that sat at "Thinking" for hours while its loop retried a
// refused provider left no trace anywhere (2026-10-11): the loops report each retry as a `provider_retry` frame, which
// only drew a status in the window. Kept here so the log, and any surface asking about a live turn, read one record.

// The last upstream retry a turn's runtime reported: its HTTP status where there was one, the vendor's own word for
// it where the loop names one (the Claude CLI's `rate_limit`, `server_error`), and which attempt it was.
export interface UpstreamRetry {
    readonly at: number;
    readonly attempt: number;
    readonly maxAttempts?: number;
    readonly nextAttemptAt?: number;
    readonly status?: number;
    readonly cause?: string;
}

export interface TurnPulse {
    readonly conversationId: string;
    readonly turnId: string;
    // The detached run carrying the turn (turn-runs.ts), whose id every transcript row is stamped with; absent for a
    // turn folded by its own caller (an automation's fire).
    readonly run?: string;
    readonly provider: string;
    readonly harness: string;
    readonly model?: string;
    readonly account?: string;
    readonly startedAt: number;
    // When the runtime last sent a frame, and what kind it was.
    readonly lastEventAt: number;
    readonly lastEvent?: string;
    readonly upstream?: UpstreamRetry;
    // Retries since the provider last answered; 0 once it answers again.
    readonly retriesSinceAnswer: number;
    // Set when the runtime is done; the record stays until the conversation's next turn, so a reader can tell a turn
    // that just ended from one still going.
    readonly endedAt?: number;
}

const pulses = new Map<string, TurnPulse>();

// A loop retrying every few seconds for hours writes one line per state and window, its count folded in.
const RETRY_LOG_EVERY_MS = 10 * 60_000;
const retryGate = createRepeatGate({ everyMs: RETRY_LOG_EVERY_MS });

// The vendor's word for a retry, noted by the loop that reads it a moment before the frame goes out (sdk-stream.ts),
// keyed by conversation since that loop knows no turn id.
const causes = new Map<string, string>();

/** What the conversation's turn last showed of itself, live or just ended; undefined when no turn ran since boot. */
export const turnPulseOf = (conversationId: string): TurnPulse | undefined => pulses.get(conversationId);

/** A turn's runtime is starting: its record replaces whatever the conversation's last turn left. */
export const beginPulse = (pulse: Omit<TurnPulse, "lastEventAt" | "retriesSinceAnswer">): void => {
    causes.delete(pulse.conversationId);
    pulses.set(pulse.conversationId, { ...pulse, lastEventAt: pulse.startedAt, retriesSinceAnswer: 0 });
};

/** The vendor's own word for the retry about to be reported on this conversation's turn. */
export const noteRetryCause = (conversationId: string | undefined, cause: string): void => {
    if (conversationId !== undefined) {
        causes.set(conversationId, cause);
    }
};

// The state a retry line is gated on: its status alone, since only one loop names a cause and not on every retry.
const retryState = (retry: UpstreamRetry): string => (retry.status === undefined ? "no-status" : String(retry.status));

// A retry folded into the pulse and, gated, onto the log: the first of each state, then one line per window.
const onRetry = (logger: Pick<Logger, "warn">, pulse: TurnPulse, event: Extract<AgentEvent, { kind: "provider_retry" }>, now: number): TurnPulse => {
    const cause = causes.get(pulse.conversationId);
    causes.delete(pulse.conversationId);
    const upstream: UpstreamRetry = {
        at: now,
        attempt: event.attempt,
        ...opt("maxAttempts", event.maxAttempts),
        ...opt("nextAttemptAt", event.nextAttemptAt),
        ...opt("status", event.status),
        ...opt("cause", cause),
    };
    const verdict = retryGate.check(pulse.turnId, retryState(upstream));
    if (verdict.log) {
        logger.warn(
            {
                conversationId: pulse.conversationId,
                turnId: pulse.turnId,
                ...opt("run", pulse.run),
                provider: pulse.provider,
                harness: pulse.harness,
                ...opt("model", pulse.model),
                ...opt("account", pulse.account),
                ...upstream,
                retriesSinceAnswer: pulse.retriesSinceAnswer + 1,
                repeated: verdict.repeated,
            },
            "turn: the provider refused or failed a request, the loop is retrying it",
        );
    }
    return { ...pulse, upstream, retriesSinceAnswer: pulse.retriesSinceAnswer + 1 };
};

/** One frame from the turn's runtime: its clock moves, a retry is noted and logged, an answer after retries says so. */
export const pulseFrame = (logger: Pick<Logger, "info" | "warn">, conversationId: string | undefined, event: AgentEvent, now: number = Date.now()): void => {
    const pulse = conversationId === undefined ? undefined : pulses.get(conversationId);
    if (pulse === undefined || pulse.endedAt !== undefined) {
        return;
    }
    const moved: TurnPulse = { ...pulse, lastEventAt: now, lastEvent: event.kind };
    if (event.kind === "provider_retry") {
        pulses.set(pulse.conversationId, onRetry(logger, moved, event, now));
        return;
    }
    if (pulse.retriesSinceAnswer > 0 && ANSWERED_FRAMES.has(event.kind)) {
        const outage = retryGate.clear(pulse.turnId);
        logger.info(
            {
                conversationId: pulse.conversationId,
                turnId: pulse.turnId,
                ...opt("run", pulse.run),
                provider: pulse.provider,
                retries: pulse.retriesSinceAnswer,
                ...opt("lastStatus", pulse.upstream?.status),
                ...opt("repeated", outage?.repeated),
            },
            "turn: the provider answered again after retries",
        );
        pulses.set(pulse.conversationId, { ...moved, retriesSinceAnswer: 0 });
        return;
    }
    pulses.set(pulse.conversationId, moved);
};

/** The turn's runtime is done; its record stays, marked ended, for whoever asks how it went. */
export const endPulse = (conversationId: string | undefined, turnId: string, now: number = Date.now()): TurnPulse | undefined => {
    const pulse = conversationId === undefined ? undefined : pulses.get(conversationId);
    if (pulse === undefined || pulse.turnId !== turnId) {
        return undefined;
    }
    retryGate.clear(turnId);
    const ended = { ...pulse, endedAt: now };
    pulses.set(pulse.conversationId, ended);
    return ended;
};
