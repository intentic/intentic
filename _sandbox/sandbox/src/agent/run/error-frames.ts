import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { TurnAllowance } from "../providers/harness-credentials.js";
import type { TurnLimit } from "../../usage/fleet-limit.js";
import {
    isAuthFailureText,
    isEntitlementRefusalText,
    isUnsentParameterRefusalText,
    mentionsSpentAllowance,
    versionFloorOf,
} from "../providers/failure-sentences.js";
import { opt } from "./opt.js";

type ErrorEvent = Extract<AgentEvent, { kind: "error" }>;

export const trialUnavailableFrame = (): ErrorEvent => ({
    kind: "error",
    code: "trial-unavailable",
    message: "Free trial unavailable. Failed messages are not counted. Retry or connect Google.",
});

const trialExhaustedFrame = (message?: string): ErrorEvent => ({
    kind: "error",
    code: "trial-exhausted",
    message: message ?? "Free trial used up for today. Connect Google to keep going free.",
});

export const trialRetryFrame = (error: string): ErrorEvent => (error === "rate_limit" ? trialExhaustedFrame() : trialUnavailableFrame());

// The SDK's `error` field is only a category ('unknown' catches every 4xx); the actual message is in the assistant
// message's text block, when present.
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
// headroom as fact rather than guessing a reset: RESOURCE_EXHAUSTED also covers per-request refusals.
const limitSentence = (vendor: string, limit: TurnLimit | undefined): string => {
    if (limit === undefined) {
        return `${vendor} usage limit reached. Send again once it resets.`;
    }
    const allowance = limit.pool === undefined ? `allowance` : `${limit.pool} allowance`;
    if (limit.withHeadroom > 0) {
        const total = limit.withHeadroom + limit.spent;
        return (
            `${vendor} refused, but ${limit.withHeadroom}/${total} accounts have headroom` +
            `${limit.pool === undefined ? `` : ` for ${limit.pool}`}. Send again or try another model.`
        );
    }
    if (limit.spent === 0) {
        return `${vendor} usage limit reached: ${allowance} exhausted. Send again once it resets.`;
    }
    const accounts = limit.spent === 1 ? `the connected account` : `all ${limit.spent} accounts`;
    return `${vendor} usage limit reached: ${allowance} spent on ${accounts}. Send again once it resets.`;
};

// One frame for both paths a spent subscription allowance takes: a terminal assistant refusal, and an api_retry frame
// with a long delay. `named` is what the failure itself said about the reset.
export const rateLimitFrame = async (allowance: TurnAllowance | undefined, named: number | undefined): Promise<ErrorEvent> => {
    // Absent for a provider with no quota surface (a keyed one); falls back to the no-allowance sentence.
    const limit = await allowance?.limit?.();
    return {
        kind: "error",
        code: "rate_limit",
        message: limitSentence(allowance?.vendor ?? "Claude", limit),
        ...opt("resetsAt", named ?? limit?.reopensAt),
    };
};

// Reports the provider outage as `provider-outage`; sdk-stream.ts's api_retry handles the wait from here.
export const retryStormFrame = (attempts: number, status: number | undefined): ErrorEvent => ({
    kind: "error",
    code: "provider-outage",
    message:
        `Provider refused ${attempts} requests${status === undefined ? `` : ` (HTTP ${status})`}. ` +
        `Work so far is kept; send again to resume. If it keeps failing, check the model and endpoint.`,
});

// A routed 5xx that is really the model not being on this plan (routed-refusal.ts); coded `model-unavailable` so the
// picker drops it instead of retrying as an outage.
export const modelUnavailableFrame = (model: string, refusal: string): ErrorEvent => ({
    kind: "error",
    code: "model-unavailable",
    message: `${refusal} Nothing here can retry past that: pick another model for this chat (${model} is off the list until the plan covers it).`,
});

// A parameter refusal coded `provider-outage` since the request isn't at fault: the breaker retries the turn from its
// existing session. Reached from the Claude, Codex, and OpenCode adapters.
export const unsentParameterFrame = (explained: string): ErrorEvent => ({
    kind: "error",
    code: "provider-outage",
    message: `${explained} This parameter was not sent by intentic. Usually clears on retry; work so far is kept.`,
});

// Reads `rate_limit`, `server_error`, and `overloaded` from the SDK's category, since a resume must be safe regardless
// of wording; everything else is decided from the message text.
export const errorFrame = async (message: SDKAssistantMessage, allowance: TurnAllowance | undefined, trial = false): Promise<ErrorEvent> => {
    if (trial) {
        const explained = apiErrorMessage(message);
        if (explained.includes(`trial_exhausted`) || /free trial used up/i.test(explained)) {
            return trialExhaustedFrame(explained);
        }
        if (
            message.error === "rate_limit" ||
            message.error === "server_error" ||
            message.error === "overloaded" ||
            explained.includes(`trial_unavailable`)
        ) {
            return trialUnavailableFrame();
        }
        return {
            kind: "error",
            code: "trial-model-unavailable",
            message: `This model could not run through the free trial. ${explained} Choose another model or connect Google.`,
        };
    }
    // Tagged as a usage cap, not a workspace fault; the only path that can read the translator's own reset.
    if (message.error === "rate_limit") {
        return rateLimitFrame(allowance, proxyCooldownReset(apiErrorMessage(message)));
    }
    if (message.error === "server_error" || message.error === "overloaded") {
        return { kind: "error", code: "provider-outage", message: apiErrorMessage(message) };
    }
    return sentenceFrame(apiErrorMessage(message));
};

// The half that reads the message text, in the order it must be read: each condition below can wear another's clothes,
// so ordering is the correctness.
const sentenceFrame = (explained: string): ErrorEvent => {
    // The seat, not the credential: read before auth failures, since a re-mint cannot fix a disabled seat.
    if (isEntitlementRefusalText(explained)) {
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
    // A credential the CLI stopped using; coded so the route can re-mint and resume rather than leave a dead tab.
    if (isAuthFailureText(explained)) {
        return { kind: "error", code: "claude-token-refused", message: explained };
    }
    // The 4xx that isn't the request's fault; last, so an allowance or credential match above still wins.
    if (isUnsentParameterRefusalText(explained)) {
        return unsentParameterFrame(explained);
    }
    return { kind: "error", message: explained };
};
