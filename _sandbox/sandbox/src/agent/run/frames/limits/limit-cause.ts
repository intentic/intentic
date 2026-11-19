import { loopDoor } from "@intentic/sandbox-contract/models/agent-catalog";
import type { AgentHarness, AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { isAdminGrantedAllowanceText, isOutOfCreditText, mentionsSpentAllowance } from "../../../../engines/failure-sentences.js";
import { readableProviderText } from "../../../../engines/provider-error-text.js";
import { namedReset, RETRY_HORIZON_S } from "../../../../usage/reset-sentences.js";
import type { RoutedTurn } from "../../../../seams/turn-starter.js";
import type { ErrorFrame, FailureContext, FailureQueries } from "../classify-failure.js";
import { withClause } from "../frame-clause.js";

/* A RATE LIMIT IS A THROTTLE UNTIL SOMETHING SHOWS AN ALLOWANCE SPENT, AND THAT IS DECIDED HERE, FOR EVERY RUNTIME. A
   provider answers "slow down" and "your plan ran out" with the same 429, the same "rate limit", the same
   RESOURCE_EXHAUSTED. The two take opposite courses: a spent allowance is filed on the refusal ledger
   (provider-refusals.ts), holds the account spent until something answers it, and books the turn for the reset; a
   throttle passes in seconds or minutes, and the turn waits on the provider's backoff like an outage
   (provider-health.ts) with nothing filed. Read the wrong way round, a throttle holds a healthy account spent.

   So a rate-limit failure is a spent allowance only on evidence (limitCause), in this order:
   - the provider's own words for a spent allowance (failure-sentences.ts mentionsSpentAllowance: the Claude CLI's
     usage-limit prefixes, "usage limit", "quota exceeded"), an admin's credit or a key out of credit (each its own case
     besides), or a reset it names further out than a retry (RETRY_HORIZON_S): these outrank everything below;
   - the translator gateway's verdict on a routed turn, which read every account's own answer (translator-gateway.ts
     causeOf): a throttle it handed back is a throttle, whatever the loop guessed;
   - a structured signal that the allowance ran out (Codex's `usageLimitExceeded`, OpenCode's `provider.quota`, Cursor's
     `usage_limit`, Muse's typed quota, the sandbox's own records calling every account spent), the gateway's `spent`, or
     an instant to ask again the provider named past the retry horizon (a Retry-After, the Claude CLI's delay on a
     native turn);
   and otherwise it is a throttle, a word nobody foresaw included: it falls back to the outage's course, which passes,
   never to a refusal that stands (docs/architecture/conventions.md, "Reading another program's output").

   A runtime decides where its evidence is (error-frames.ts for the Claude CLI and every loop's words, codex-agent.ts,
   opencode-failures.ts, cursor-failures.ts and cursor-agent.ts, muse-stream.ts, claude-code-stream.ts's retries,
   limit-wait.ts's hand-over), and the turn's door decides once more for a routed turn with the gateway's verdict
   (throttleAsOutage, stream-agent.ts and sealed-request.ts, then classify-failure.ts again as a no-op). A throttle goes
   out as `provider-outage` marked `throttle`, which opens the provider's backoff as a throttle (provider-health.ts) and is
   never filed; `rate_limit` keeps meaning a spent allowance, for the editor and every stored record.

   2026-11-14/15: routed turns alone told the two apart, after Google's bare "Resource has been exhausted (e.g. check
   quota)." flipped 31 Gemini accounts spent and back about four hundred times in an afternoon, and then held the turn
   "behind a spent allowance" beside a Usage left that rightly showed 95% of the pool. 2026-11-19: every other path still
   coded any 429 `rate_limit` (the Claude CLI's category and its retries, Codex's 429s, OpenCode's, Cursor's, Muse's, and
   the words every loop shares), and the classifier filed each as a spent allowance, so a native Claude account, a Codex
   or a Cursor one was held spent by a throttle until a reading or a turn answered it. Matching more throttle wordings
   was rejected: the next one nobody foresaw would be filed again. */

/** Whether a turn's requests go through the daemon's translator gateway, which places each one on an account of its own. */
export const routedTurn = (provider: AgentProvider, harness: AgentHarness): boolean =>
    KeyedProviderSchema.safeParse(provider).success && loopDoor(provider, harness) === undefined;

/** What a rate-limit failure is evidence of: an allowance spent, which stands until it reopens, or a throttle, which passes. */
export type LimitCause = "spent" | "throttle";

// What the translator gateway made of a routed model's refusals since the request began (FailureQueries.gatewayRefused).
type GatewayVerdict = ReturnType<NonNullable<FailureQueries["gatewayRefused"]>>;

export interface LimitEvidence {
    // The provider's own words, where it gave any. Never the sandbox's own sentence: it says what it was told to.
    readonly said?: string | undefined;
    // A structured signal that the allowance itself ran out (a typed kind or code, the records calling it spent).
    readonly spent?: boolean | undefined;
    // When the provider said to ask again, in epoch seconds: a Retry-After a loop honoured, the CLI's retry delay.
    readonly retryAt?: number | undefined;
    // The gateway's verdict on a routed turn, asked only where the words have not decided already.
    readonly gateway?: (() => GatewayVerdict) | undefined;
    // Epoch ms, for the instants above.
    readonly now?: number | undefined;
}

// An instant further out than a provider's retry: an allowance reopening, not a request let through again.
const pastRetryHorizon = (at: number | undefined, now: number): boolean => at !== undefined && at - now / 1000 > RETRY_HORIZON_S;

/**
 * Whether a provider's own words say an allowance is spent: the phrasebook's words for it, an admin's credit, or a reset
 * named further out than a retry (read in a JSON body's message too). The gateway reads a routed refusal by the same
 * words (translator-gateway.ts causeOf).
 */
export const saysSpent = (said: string, now: number = Date.now()): boolean =>
    mentionsSpentAllowance(said) || isAdminGrantedAllowanceText(said) || pastRetryHorizon(namedReset(readableProviderText(said), now) ?? namedReset(said, now), now);

/** The one decision: a rate-limit failure is a spent allowance only on evidence (above), and a throttle otherwise. */
export const limitCause = (evidence: LimitEvidence): LimitCause => {
    const now = evidence.now ?? Date.now();
    const { said } = evidence;
    // A key out of credit is no throttle either: a wall of its own (error-frames.ts keyOutOfCreditFrame), which no wait lifts.
    if (said !== undefined && (saysSpent(said, now) || isOutOfCreditText(said))) {
        return "spent";
    }
    const gateway = evidence.gateway?.();
    if (gateway === "throttled") {
        return "throttle";
    }
    return evidence.spent === true || gateway === "spent" || pastRetryHorizon(evidence.retryAt, now) ? "spent" : "throttle";
};

/* What a throttle's frame adds to the provider's words: why it is not held as a spent allowance. The sandbox's own
   sentence, where the frame was one, is replaced by it instead, since that sentence said an allowance was spent. */
const THROTTLED =
    "The provider is rate-limiting this model for now, not refusing an allowance: nothing it said shows one spent, so nothing is held against an account and Usage left still shows its room.";

/** A rate-limit failure as the throttle it is: an outage marked `throttle`, without the loop's retry instant, which was never a reset. */
export const throttled = (frame: ErrorFrame): ErrorFrame => {
    const { resetsAt: _loopRetry, code: _code, ...rest } = frame;
    const message = frame.own === true ? THROTTLED : withClause(readableProviderText(frame.message), THROTTLED);
    return { ...rest, code: "provider-outage", throttle: true, message };
};

/** A rate-limit failure's frame by the evidence: `rate_limit` for a spent allowance, else the throttle it is. */
export const limitFrame = (frame: ErrorFrame, evidence: Omit<LimitEvidence, "said"> = {}): ErrorFrame =>
    limitCause({ ...evidence, said: frame.own === true ? undefined : frame.message }) === "spent" ? { ...frame, code: "rate_limit" } : throttled(frame);

/**
 * A routed turn's `rate_limit` as the gateway's verdict leaves it, at the door every turn's frames go out by: the
 * runtime's call stands unless the gateway handed back a throttle and the provider's own words do not say an allowance
 * is spent. A turn held at the door sent nothing, so no verdict of the gateway's is about it. Any other frame as it came.
 */
export const throttleAsOutage = (
    event: ErrorFrame,
    context: Pick<FailureContext, "provider" | "model" | "door"> & { readonly turn: Pick<RoutedTurn, "harness"> },
    gateway: FailureQueries["gatewayRefused"],
): ErrorFrame => {
    const model = context.model === "" ? undefined : context.model;
    if (event.code !== "rate_limit" || context.door === true || model === undefined || !routedTurn(context.provider, context.turn.harness)) {
        return event;
    }
    const verdict = gateway === undefined ? undefined : () => gateway(context.provider, model);
    return limitCause({ said: event.own === true ? undefined : event.message, spent: true, gateway: verdict }) === "spent" ? event : throttled(event);
};
