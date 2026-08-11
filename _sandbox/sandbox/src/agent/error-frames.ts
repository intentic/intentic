import type { SDKAssistantMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import type { TurnAllowance } from "./harness-credentials.js";
import type { TurnLimit } from "../usage/translator-usage.js";
import { isAuthFailureText, isEntitlementRefusalText, isUsageLimitText } from "./failure-sentences.js";
import { opt } from "./opt.js";

type ErrorEvent = Extract<AgentEvent, { kind: "error" }>;

// What the UI shows for an API-level failure. The SDK's `error` field is only a CATEGORY, and 'unknown' is its
// catch-all for everything it can't bucket — every 4xx lands there. The synthetic assistant message carrying it
// holds the API's actual sentence in its text block ("API Error: 400 output_config.effort 'max' is not supported
// when thinking is disabled on this model", say), which is the only part anyone can act on: reporting the
// category alone turns a precise, fixable complaint into a shrug. Text wins, category is the fallback.
const apiErrorMessage = (message: SDKAssistantMessage): string => {
    const content = message.message.content as ReadonlyArray<{ type: string; text?: string }>;
    const explained = content.find((block) => block.type === "text" && block.text !== undefined && block.text.trim() !== "")?.text;
    return explained ?? `agent error: ${message.error}`;
};

/* THE PROXY'S OWN ANSWER ABOUT WHEN TO COME BACK, when it survives the trip. CLIProxyAPI refuses a fleet-wide
 * cooldown with a JSON body — {"error":{"code":"model_cooldown","message":"All credentials for model X are
 * cooling down","reset_seconds":N}} — and the harness prints that body as the API error's text. `reset_seconds`
 * is the one number separating a credential cooling for a minute from a weekly wall days out, and it is read off
 * the proxy's own scheduler rather than inferred from a snapshot up to five minutes stale, so it wins over the
 * recorded quota wherever it appears.
 *
 * Both markers are required because the number alone is not the claim — some other provider's error body may
 * carry a `reset_seconds` meaning something else entirely. Absent on the api_retry path, which carries counters
 * and a category and no body at all: this is an upgrade over the recorded quota, never a dependency on it. */
const proxyCooldownReset = (explained: string, now: number = Date.now()): number | undefined => {
    const seconds = /"reset_seconds"\s*:\s*(\d+)/.exec(explained);
    return seconds === null || !explained.includes(`"model_cooldown"`) ? undefined : Math.ceil(now / 1000) + Number(seconds[1]);
};

/* WHAT A SPENT ALLOWANCE READS AS — three situations wearing one 429, and the reason a single sentence could
 * never be right about all of them.
 *
 * `vendor` because the harness is not the vendor on a routed turn (see TurnAllowance): naming Anthropic for a
 * Google quota sends the user to the wrong account. The POOL because Google meters Gemini separately from the
 * Claude and GPT models off one sign-in, so "the allowance" names two different things depending on the model
 * that was running. And the COUNTS because there is no "this account" behind a translator that balances across
 * every credential it holds — that phrasing is only true of a native Claude turn, which is exactly where it is
 * kept.
 *
 * The middle case is the one that cost the most. Headroom left on file means the quota is NOT what refused this
 * turn: the translator had every credential cooling for some other reason — a transient upstream error cools one
 * for a minute — and sending someone away until Monday over a condition that clears in seconds is worse than
 * saying nothing at all. */
const limitSentence = (vendor: string, limit: TurnLimit | undefined): string => {
    if (limit === undefined) {
        return `${vendor} usage limit reached — this account's allowance is exhausted, not a provider outage. Send again once it resets to carry on from here.`;
    }
    const allowance = limit.pool === undefined ? `allowance` : `${limit.pool} allowance`;
    if (limit.withHeadroom > 0) {
        const total = limit.withHeadroom + limit.spent;
        return (
            `${vendor} refused this turn, but ${limit.withHeadroom} of ${total} connected accounts still ` +
            `${limit.withHeadroom === 1 ? `has` : `have`} headroom${limit.pool === undefined ? `` : ` for ${limit.pool}`} — every ` +
            `credential is cooling down rather than spent, so this clears in moments rather than at a reset.`
        );
    }
    // Nothing measured either way: the pool was never polled, or the provider has renamed the bucket it is
    // reported under. Say a limit was hit and claim nothing about a fleet we cannot see.
    if (limit.spent === 0) {
        return `${vendor} usage limit reached — the ${allowance} is exhausted, not a provider outage. Send again once it resets to carry on from here.`;
    }
    const accounts = limit.spent === 1 ? `the connected account` : `all ${limit.spent} connected accounts`;
    return `${vendor} usage limit reached — the ${allowance} is spent on ${accounts}, not a provider outage. Send again once it resets to carry on from here.`;
};

// One frame for both ways a spent subscription allowance reaches us: an assistant refusal after the harness
// gives up, and the earlier api_retry frame whose long delay says it intends to wait for the reset. Keeping it
// here prevents the live-retry path from drifting back into calling the same condition an outage while the
// terminal path calls it a limit. `named` is what the failure ITSELF said about when to come back — see the two
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

/* WHICH CONDITION an API failure actually is — the frame the client branches on.
 *
 * Two of these read the CATEGORY the SDK filed, and two read the SENTENCE, and the split is not arbitrary. A
 * spent allowance and a refused credential arrive as prose under whatever category the failing layer happened to
 * pick (see failure-sentences.ts), so there the text is the only signal. A provider outage
 * does not: the harness buckets every 5xx, every 529 at capacity, and every dropped socket as `server_error`, and
 * a pre-retry capacity refusal as `overloaded`. Those two categories mean precisely "the provider failed us and
 * the request is worth making again", which is the one claim an automatic resume has to be right about — so it is
 * read from the category and never from the wording, which changes with every CLI release.
 *
 * Everything else stays uncoded and reads as the red line it is: 4xx all land in the SDK's `unknown` bucket, and
 * a malformed request re-sent on a timer is a loop, not a recovery. */
export const errorFrame = async (message: SDKAssistantMessage, allowance: TurnAllowance | undefined): Promise<ErrorEvent> => {
    // rate_limit is the subscription usage cap, not a workspace fault — tag it so the UI can render it as a
    // "wait and retry" notice instead of a red crash line (see conversation.ts). A limit hit the SDK filed under
    // another category keeps its own sentence (the CLI's "You've hit your session limit · resets …" names the
    // reset; our canned line doesn't) but carries the same code, so every spent-allowance failure reaches the
    // client as one condition. This is the ONE path that still holds the API's body, so it is the only one that
    // can offer the translator's own reset — see proxyCooldownReset.
    if (message.error === "rate_limit") {
        return rateLimitFrame(allowance, proxyCooldownReset(apiErrorMessage(message)));
    }
    if (message.error === "server_error" || message.error === "overloaded") {
        return { kind: "error", code: "provider-outage", message: apiErrorMessage(message) };
    }
    const explained = apiErrorMessage(message);
    if (isUsageLimitText(explained)) {
        return { kind: "error", code: "rate_limit", message: explained };
    }
    /* The seat, not the credential: this account authenticates perfectly and its organization has switched
     * Claude Code off for it. ABOVE the auth branch because the two are only distinguishable by the sentence and
     * the recoveries are opposite — a re-mint is what a refused token wants and the one thing that cannot help
     * here, so coding this as that would spend a retry, fail identically, and leave the user reconnecting an
     * account that was never disconnected. */
    if (isEntitlementRefusalText(explained)) {
        return { kind: "error", code: "claude-not-entitled", message: explained };
    }
    // A credential the CLI has stopped trying to use (failure-sentences.ts). Coded so the route can re-mint and
    // resume the turn instead of leaving a dead tab for a human to restart by hand — the same "not a workspace
    // fault" treatment a spent allowance gets.
    if (isAuthFailureText(explained)) {
        return { kind: "error", code: "claude-token-refused", message: explained };
    }
    return { kind: "error", message: explained };
};
