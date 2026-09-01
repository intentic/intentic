import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { TurnAllowance } from "./harness-credentials.js";
import type { TurnLimit } from "../usage/translator-usage.js";
import {
    isAuthFailureText,
    isEntitlementRefusalText,
    isUnsentParameterRefusalText,
    mentionsSpentAllowance,
    versionFloorOf,
} from "./failure-sentences.js";
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

// What the UI shows for an API-level failure. The SDK's `error` field is only a CATEGORY, and 'unknown' is its
// catch-all for everything it can't bucket, every 4xx lands there. The synthetic assistant message carrying it
// holds the API's actual sentence in its text block ("API Error: 400 output_config.effort 'max' is not supported
// when thinking is disabled on this model", say), which is the only part anyone can act on: reporting the
// category alone turns a precise, fixable complaint into a shrug. Text wins, category is the fallback.
const apiErrorMessage = (message: SDKAssistantMessage): string => {
    const content = message.message.content as ReadonlyArray<{ type: string; text?: string }>;
    const explained = content.find((block) => block.type === "text" && block.text !== undefined && block.text.trim() !== "")?.text;
    return explained ?? `agent error: ${message.error}`;
};

/* THE PROXY'S OWN ANSWER ABOUT WHEN TO COME BACK, when it survives the trip. CLIProxyAPI refuses a fleet-wide
 * cooldown with a JSON body: {"error":{"code":"model_cooldown","message":"All credentials for model X are
 * cooling down","reset_seconds":N}}, and the harness prints that body as the API error's text. `reset_seconds`
 * is the one number separating a credential cooling for a minute from a weekly wall days out, and it is read off
 * the proxy's own scheduler rather than inferred from a snapshot up to five minutes stale, so it wins over the
 * recorded quota wherever it appears.
 *
 * Both markers are required because the number alone is not the claim, some other provider's error body may
 * carry a `reset_seconds` meaning something else entirely. Absent on the api_retry path, which carries counters
 * and a category and no body at all: this is an upgrade over the recorded quota, never a dependency on it. */
const proxyCooldownReset = (explained: string, now: number = Date.now()): number | undefined => {
    const seconds = /"reset_seconds"\s*:\s*(\d+)/.exec(explained);
    return seconds === null || !explained.includes(`"model_cooldown"`) ? undefined : Math.ceil(now / 1000) + Number(seconds[1]);
};

/* WHAT A SPENT ALLOWANCE READS AS, three situations wearing one 429, and the reason a single sentence could
 * never be right about all of them.
 *
 * `vendor` because the harness is not the vendor on a routed turn (see TurnAllowance): naming Anthropic for a
 * Google quota sends the user to the wrong account. The POOL because Google meters Gemini separately from the
 * Claude and GPT models off one sign-in, so "the allowance" names two different things depending on the model
 * that was running. And the COUNTS because there is no "this account" behind a translator that balances across
 * every credential it holds, that phrasing is only true of a native Claude turn, which is exactly where it is
 * kept.
 *
 * The middle case is the one that cost the most, twice, in opposite directions. Headroom left on file means the
 * quota is NOT what refused this turn, and the first version of this sentence said so and then guessed WHY,
 * "every credential is cooling down rather than spent, so this clears in moments rather than at a reset".
 * Sending someone away until Monday over a condition that clears in seconds is worse than saying nothing; so is
 * promising it clears in moments when it never will.
 *
 * That promise was measured wrong: Google answers a request it objects to with the same `RESOURCE_EXHAUSTED` it
 * uses for a spent quota, so a refusal every account shares reads here as a fleet-wide cooldown. It was one for
 * days, a Claude Code turn carrying an identity line Google refuses, on 31 accounts at ~0% utilization, telling
 * the user each time that it would clear in moments.
 *
 * So the sentence now states the FACT it can stand behind (the meters say there is room, so a reset is not what
 * you are waiting for) and stops predicting the recovery it cannot see. Naming the other possibility is what
 * turns a wrong promise into a useful one: if it keeps happening, the request is being refused, not the quota. */
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

// One frame for both ways a spent subscription allowance reaches us: an assistant refusal after the harness
// gives up, and the earlier api_retry frame whose long delay says it intends to wait for the reset. Keeping it
// here prevents the live-retry path from drifting back into calling the same condition an outage while the
// terminal path calls it a limit. `named` is what the failure ITSELF said about when to come back, see the two
// call sites, which have different things to offer and neither of which is always right on its own.
export const rateLimitFrame = async (allowance: TurnAllowance | undefined, named: number | undefined): Promise<ErrorEvent> => {
    const limit = await allowance?.limit();
    return {
        kind: "error",
        code: "rate_limit",
        message: limitSentence(allowance?.vendor ?? "Claude", limit),
        ...opt("resetsAt", named ?? limit?.reopensAt),
    };
};

/* THE PROVIDER IS REFUSING EVERY REQUEST, said as the outage it is, so the daemon's own waiting machinery takes
 * the turn from here (sdk-stream.ts's api_retry cap has the whole argument for why the wait moves out of the
 * live process).
 *
 * Coded `provider-outage` because that is what the harness's own last attempt would have called it, and the
 * whole recovery path keys off the code: the breaker opens, the resume offer appears, the card settles. The
 * count and the status are in the sentence because they are the only evidence the reader has that this is a
 * provider refusing everything rather than a slow turn, and the last clause is the one that matters for the
 * case this bound was written for: a provider that fails identically on every send is misconfigured, not down,
 * and no amount of waiting fixes a request it will never accept. */
export const retryStormFrame = (attempts: number, status: number | undefined): ErrorEvent => ({
    kind: "error",
    code: "provider-outage",
    message:
        `Provider refused ${attempts} requests${status === undefined ? `` : ` (HTTP ${status})`}. ` +
        `Work so far is kept; send again to resume. If it keeps failing, check the model and endpoint.`,
});

/* A PARAMETER THE TURN NEVER ASKED FOR, refused as if it had (failure-sentences.ts holds the evidence and the
 * narrowing). Coded `provider-outage` for the same reason every 5xx is: the request is not what is wrong, so the
 * breaker owns the waiting and the turn is re-run from the session it already built rather than dying on a red
 * line. Exported because three adapters reach it by different routes (the Claude harness's API error text, the
 * Codex app-server's turn.failed, OpenCode's session.error) and one sentence for one condition is the point:
 * the provider's own words first, then the only fact the reader cannot check for themselves. */
export const unsentParameterFrame = (explained: string): ErrorEvent => ({
    kind: "error",
    code: "provider-outage",
    message: `${explained} This parameter was not sent by intentic. Usually clears on retry; work so far is kept.`,
});

/* WHICH CONDITION an API failure actually is, the frame the client branches on.
 *
 * Two of these read the CATEGORY the SDK filed, and two read the SENTENCE, and the split is not arbitrary. A
 * spent allowance and a refused credential arrive as prose under whatever category the failing layer happened to
 * pick (see failure-sentences.ts), so there the text is the only signal. A provider outage
 * does not: the harness buckets every 5xx, every 529 at capacity, and every dropped socket as `server_error`, and
 * a pre-retry capacity refusal as `overloaded`. Those two categories mean precisely "the provider failed us and
 * the request is worth making again", which is the one claim an automatic resume has to be right about, so it is
 * read from the category and never from the wording, which changes with every CLI release.
 *
 * Everything else stays uncoded and reads as the red line it is: 4xx all land in the SDK's `unknown` bucket, and
 * a malformed request re-sent on a timer is a loop, not a recovery. */
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
    // rate_limit is the subscription usage cap, not a workspace fault, tag it so the UI can render it as a
    // "wait and retry" notice instead of a red crash line (see conversation.ts). A limit hit the SDK filed under
    // another category keeps its own sentence (the CLI's "You've hit your session limit · resets …" names the
    // reset; our canned line doesn't) but carries the same code, so every spent-allowance failure reaches the
    // client as one condition. This is the ONE path that still holds the API's body, so it is the only one that
    // can offer the translator's own reset, see proxyCooldownReset.
    if (message.error === "rate_limit") {
        return rateLimitFrame(allowance, proxyCooldownReset(apiErrorMessage(message)));
    }
    if (message.error === "server_error" || message.error === "overloaded") {
        return { kind: "error", code: "provider-outage", message: apiErrorMessage(message) };
    }
    return sentenceFrame(apiErrorMessage(message));
};

/* THE HALF THAT READS THE SENTENCE, in the order it has to be read in. Split out from errorFrame above (which
 * keeps the two branches that read the SDK's CATEGORY) because the ordering below is the whole of its
 * correctness: every one of these conditions can wear another's clothes, and each comment says which neighbour
 * it must be read before, and why. */
const sentenceFrame = (explained: string): ErrorEvent => {
    /* The seat, not the credential: this account authenticates perfectly and its organization has switched
     * Claude Code off for it. ABOVE the auth branch because the two are only distinguishable by the sentence and
     * the recoveries are opposite, a re-mint is what a refused token wants and the one thing that cannot help
     * here, so coding this as that would spend a retry, fail identically, and leave the user reconnecting an
     * account that was never disconnected. */
    if (isEntitlementRefusalText(explained)) {
        return { kind: "error", code: "claude-not-entitled", message: explained };
    }
    /* THE ENGINE IS TOO OLD FOR THE MODEL. Read before every branch below it because it wears a 400 and would
     * otherwise land in the catch-all as a sentence nobody can act on, which is exactly what it was until the
     * engine store existed: a fleet-wide outage on one model, fixable only by shipping an image.
     *
     * The numbers ride the frame rather than only the prose (schemas/engines.ts): the card turns them into one
     * button, which installs the lowest version at or above the floor. That install is offered rather than
     * taken, because a version that satisfies a floor the blessed list has not caught up with is by definition
     * one nobody has tested here yet. */
    const floor = versionFloorOf(explained);
    if (floor !== undefined) {
        return {
            kind: "error",
            code: "engine-version-floor",
            message: explained,
            engine: { id: "claude", floor: floor.floor, ...opt("running", floor.running) },
        };
    }
    /* A SPENT ALLOWANCE WEARING A CREDENTIAL'S CLOTHES, and it has to be read before the auth branch below.
     *
     * Kimi refuses a spent Kimi Code plan with `403 You've reached your usage limit for this billing cycle`, and
     * a 403 is what the CLI prints its "Failed to authenticate" prefix over, so the sentence satisfies
     * isAuthFailureText and went out as a refused CREDENTIAL. The client reads that code as "reconnect the
     * account", which is a fix for a condition the user does not have: the account is in perfect health and the
     * only thing wrong with it is that its quota is gone until the cycle turns.
     *
     * Read from the SENTENCE, like the two conditions above it, and for the reason failure-sentences.ts gives:
     * the harness only knows Anthropic's vocabulary and every routed provider refuses in its own words. Coded as
     * the limit it is, so it lands on the client's limit branch, a muted wait-and-retry notice carrying the
     * provider's own sentence, instead of lighting the reconnect banner. */
    if (mentionsSpentAllowance(explained)) {
        return { kind: "error", code: "rate_limit", message: explained };
    }
    // A credential the CLI has stopped trying to use (failure-sentences.ts). Coded so the route can re-mint and
    // resume the turn instead of leaving a dead tab for a human to restart by hand, the same "not a workspace
    // fault" treatment a spent allowance gets.
    if (isAuthFailureText(explained)) {
        return { kind: "error", code: "claude-token-refused", message: explained };
    }
    // The 4xx that is not the request's fault, and the only one: see unsentParameterFrame. Last, so a refusal
    // that ALSO reads as a spent allowance, a dead seat or a refused token keeps the code whose recovery is
    // specific, and this catches only what would otherwise have gone out uncoded.
    if (isUnsentParameterRefusalText(explained)) {
        return unsentParameterFrame(explained);
    }
    return { kind: "error", message: explained };
};
