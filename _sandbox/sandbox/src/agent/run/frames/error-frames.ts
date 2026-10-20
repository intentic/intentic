import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent, AgentErrorCode } from "@intentic/sandbox-contract/events/agent-events";
import type { TurnAllowance } from "../../providers/harness-credentials.js";
import type { FleetCapacity } from "@intentic/sandbox-contract/models/plan-pools";
import {
    isAuthFailureText,
    isContextOverflowText,
    isEntitlementRefusalText,
    isRateLimited,
    isUnsentParameterRefusalText,
    mentionsSpentAllowance,
    versionFloorOf,
} from "../../../engines/failure-sentences.js";
import { opt } from "../../../opt.js";
import type { RefusalPoint } from "../refusal-fork.js";

type ErrorEvent = Extract<AgentEvent, { kind: "error" }>;

export const trialUnavailableFrame = (): ErrorEvent => ({
    kind: "error",
    code: "trial-unavailable",
    message: "Free trial unavailable. Failed agent steps are not counted. Retry, or connect a model of your own.",
    own: true,
});

const trialExhaustedFrame = (message?: string): ErrorEvent =>
    message === undefined
        ? {
              kind: "error",
              code: "trial-exhausted",
              message: "Free trial used up for today: every free agent step is spent. Connect a model to keep going.",
              own: true,
          }
        : { kind: "error", code: "trial-exhausted", message };

export const trialRetryFrame = (error: string): ErrorEvent => (error === "rate_limit" ? trialExhaustedFrame() : trialUnavailableFrame());

// The SDK's `error` field is a category (SDKAssistantMessageError: `authentication_failed` for a 401/403,
// `oauth_org_not_allowed`, `billing_error`, `invalid_request` for most 400s, `unknown` for the API errors the CLI does
// not sort); the sentence is in the assistant message's text block, when present.
const apiErrorMessage = (message: SDKAssistantMessage): string => {
    const content = message.message.content as ReadonlyArray<{ type: string; text?: string }>;
    const explained = content.find((block) => block.type === "text" && block.text !== undefined && block.text.trim() !== "")?.text;
    return explained ?? `agent error: ${message.error}`;
};

// Reads `reset_seconds` from CLIProxyAPI's `model_cooldown` JSON body (epoch seconds added to now); requires both
// markers since `reset_seconds` alone could belong to another provider's body.
const proxyCooldownReset = (explained: string, now: number = Date.now()): number | undefined => {
    const seconds = /"reset_seconds"\s*:\s*(\d+)/.exec(explained);
    return seconds === null || !explained.includes(`"model_cooldown"`) ? undefined : Math.ceil(now / 1000) + Number(seconds[1]);
};

// States vendor, pool, and per-account balance for a spent-allowance refusal, since these vary by turn type. Reports
// what the records say as fact rather than guessing a reset: RESOURCE_EXHAUSTED also covers per-request refusals.
const limitSentence = (vendor: string, capacity: FleetCapacity | undefined): string => {
    if (capacity?.kind === "serving") {
        return `${vendor} refused, but ${capacity.serving}/${capacity.accounts} accounts may still serve it. Send again or try another model.`;
    }
    if (capacity?.kind !== "spent") {
        return `${vendor} usage limit reached. Send again once it resets.`;
    }
    const allowance = capacity.pool === undefined ? `allowance` : `${capacity.pool} allowance`;
    const accounts = capacity.accounts === 1 ? `the connected account` : `all ${capacity.accounts} accounts`;
    return `${vendor} usage limit reached: ${allowance} spent on ${accounts}. Send again once it resets.`;
};

// One frame for both paths a spent subscription allowance takes: a terminal assistant refusal, and an api_retry frame
// with a long delay. `named` is what the failure itself said about the reset.
export const rateLimitFrame = async (allowance: TurnAllowance | undefined, named: number | undefined): Promise<ErrorEvent> => {
    // Absent for a provider with no quota surface (a keyed one); falls back to the no-allowance sentence.
    const capacity = await allowance?.capacity?.();
    return {
        kind: "error",
        code: "rate_limit",
        message: limitSentence(allowance?.vendor ?? "Claude", capacity),
        own: true,
        ...opt("resetsAt", named ?? (capacity?.kind === "spent" ? capacity.reopensAt : undefined)),
    };
};

// Reports the provider outage as `provider-outage`; sdk-stream.ts's api_retry handles the wait from here.
export const retryStormFrame = (attempts: number, status: number | undefined): ErrorEvent => ({
    kind: "error",
    code: "provider-outage",
    message:
        `Provider refused ${attempts} requests${status === undefined ? `` : ` (HTTP ${status})`}. ` +
        `Work so far is kept; send again to resume. If it keeps failing, check the model and endpoint.`,
    own: true,
});

// A routed 5xx that is really the model not being on this plan (routed-refusal.ts); coded `model-unavailable` so the
// picker drops it instead of retrying as an outage. A spent allowance arrives in the same envelope ("Failed to
// authenticate. API Error: 403 You've reached your 5-hour usage limit"), and filed as the model being off the plan it hid
// that model for a day while the window reopened in two hours, where a sibling refused by the same limit was held for the
// reset (2026-10-17): the allowance's wording is read first, and it goes out as the spent allowance it is.
export const modelUnavailableFrame = (model: string, refusal: string): ErrorEvent =>
    mentionsSpentAllowance(refusal)
        ? { kind: "error", code: "rate_limit", message: refusal }
        : {
              kind: "error",
              code: "model-unavailable",
              message: `${refusal} Nothing here can retry past that: pick another model for this chat (${model} is off the list until the plan covers it).`,
          };

// A session past the model's window, in the provider's own words; coded so the daemon re-runs the turn in a fresh
// session, since resuming this one only overflows again (classify-failure.ts).
export const contextOverflowFrame = (explained: string): ErrorEvent => ({ kind: "error", code: "context-overflow", message: explained });

// A parameter refusal coded `provider-outage` since the request isn't at fault: the breaker retries the turn from its
// existing session. Reached from the Claude, Codex, and OpenCode adapters.
export const unsentParameterFrame = (explained: string): ErrorEvent => ({
    kind: "error",
    code: "provider-outage",
    message: `${explained} This parameter was not sent by intentic. Usually clears on retry; work so far is kept.`,
});

// The provider's safety classifier stopped the turn, in the CLI's own words: coded so the daemon holds it for a person
// rather than sending it again into the session that still carries the stopped response (classify-failure.ts).
export const safeguardFrame = (message: SDKAssistantMessage, point: RefusalPoint): ErrorEvent => {
    const frame: ErrorEvent = { kind: "error", code: "safeguard-flagged", message: apiErrorMessage(message) };
    return point.category === undefined && point.resumeAt === undefined ? frame : { ...frame, refusal: point };
};

// A platform-owned trial turn's failure: the pool's own refusals, then a session past its window, which a fresh session
// on the same model can hold; anything else is a model the trial cannot run.
const trialFrame = (message: SDKAssistantMessage): ErrorEvent => {
    const explained = apiErrorMessage(message);
    if (explained.includes(`trial_exhausted`) || /free trial used up/i.test(explained)) {
        return trialExhaustedFrame(explained);
    }
    if (message.error === "rate_limit" || message.error === "server_error" || message.error === "overloaded" || explained.includes(`trial_unavailable`)) {
        return trialUnavailableFrame();
    }
    if (isContextOverflowText(explained)) {
        return contextOverflowFrame(explained);
    }
    return {
        kind: "error",
        code: "trial-model-unavailable",
        message: `This model could not run through the free trial. ${explained} Choose another model, or connect one of your own.`,
    };
};

// Reads `rate_limit`, `server_error`, and `overloaded` from the SDK's category, since a resume must be safe regardless
// of wording; everything else is decided in sentenceFrame, the category first where it names the case.
export const errorFrame = async (message: SDKAssistantMessage, allowance: TurnAllowance | undefined, trial = false): Promise<ErrorEvent> => {
    if (trial) {
        return trialFrame(message);
    }
    // Tagged as a usage cap, not a workspace fault; the only path that can read the translator's own reset.
    if (message.error === "rate_limit") {
        return rateLimitFrame(allowance, proxyCooldownReset(apiErrorMessage(message)));
    }
    if (message.error === "server_error" || message.error === "overloaded") {
        return { kind: "error", code: "provider-outage", message: apiErrorMessage(message) };
    }
    return sentenceFrame(apiErrorMessage(message), message.error);
};

// The half that reads the message text, in the order it must be read: each condition below can wear another's clothes,
// so ordering is the correctness. Where the CLI's category names a case (the org-disabled seat, a refused credential),
// it decides that case whatever the sentence says, and the sentence is the fallback for a message without one; the
// conditions the category cannot see (a spent plan behind a 403) are still read first.
const sentenceFrame = (explained: string, category: SDKAssistantMessage["error"]): ErrorEvent => {
    // The seat, not the credential: read before auth failures, since a re-mint cannot fix a disabled seat.
    if (category === "oauth_org_not_allowed" || isEntitlementRefusalText(explained)) {
        return { kind: "error", code: "claude-not-entitled", message: explained };
    }
    // Read before every branch below: a 400 model-floor refusal would otherwise reach the catch-all as dead text.
    const floor = versionFloorOf(explained);
    if (floor !== undefined) {
        return {
            kind: "error",
            code: "engine-version-floor",
            message: explained,
            engine: { id: "claude", floor: floor.floor, ...opt("running", floor.running) },
        };
    }
    // A spent allowance wearing a credential's clothes; read before the auth branch to avoid coding it as refused.
    if (mentionsSpentAllowance(explained)) {
        return { kind: "error", code: "rate_limit", message: explained };
    }
    // A credential the CLI stopped using; coded so the route can re-mint and resume rather than leave a dead tab. The
    // category covers the CLI's other sentences for a 401/403 ("Please run /login · …", a gateway's or a key's).
    if (category === "authentication_failed" || isAuthFailureText(explained)) {
        return { kind: "error", code: "claude-token-refused", message: explained };
    }
    // A routed model's words for a session past its window, or the CLI's; below the refusals, which each outrank it.
    if (isContextOverflowText(explained)) {
        return contextOverflowFrame(explained);
    }
    // The 4xx that isn't the request's fault; last, so an allowance or credential match above still wins.
    if (isUnsentParameterRefusalText(explained)) {
        return unsentParameterFrame(explained);
    }
    return { kind: "error", message: explained };
};

// One way a runtime recognises a failure only its own loop words (a model id its server refuses), and the code it carries.
export type FailureRule = readonly [recognizes: (message: string) => boolean, code: AgentErrorCode];

// What every runtime's words are read for, after its own rules: a spent allowance or a rate limit, then a session past
// its window. A provider's wording does not depend on the loop in front of it, so neither does this list.
const SHARED_RULES: readonly FailureRule[] = [
    [isRateLimited, "rate_limit"],
    [isContextOverflowText, "context-overflow"],
];

/**
 * A provider's or a harness's failure coded by its words where nothing typed it: a parameter this sandbox never sent
 * first (`400 ... not supported on this model` would otherwise read as a bad model pick), then the runtime's own rules in
 * its order, then the rules every runtime shares. A coded frame, or one the sandbox worded itself (whose author coded it,
 * or left it uncoded on purpose), comes back as it is. Every runtime's frames pass through this at the one door they all
 * go out by (stream-agent's run loop), so a sentence read on one loop is read on all of them.
 */
export const codedFailure = (frame: ErrorEvent, rules: readonly FailureRule[] = []): ErrorEvent => {
    if (frame.code !== undefined || frame.own === true) {
        return frame;
    }
    if (isUnsentParameterRefusalText(frame.message)) {
        return unsentParameterFrame(frame.message);
    }
    const rule = [...rules, ...SHARED_RULES].find(([recognizes]) => recognizes(frame.message));
    return rule === undefined ? frame : { ...frame, code: rule[1] };
};
