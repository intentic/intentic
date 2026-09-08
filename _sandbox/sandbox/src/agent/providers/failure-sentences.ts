import { sdk } from "../../runtimes/claude/claude-sdk.js";

// Two conditions the CLI reports only as prose, never a thrown error: a spent subscription allowance and a credential
// it has stopped trying. Matched on the CLI's own prefixes, not text-sniffed. They differ for recovery (wait vs
// re-mint, turn-resume.ts) but share what every other caller needs: isFailureSentence guards the whole family, not just
// one member.

// A spent Claude allowance ("You've hit your session limit · resets …"), matched on the SDK's own prefixes, not guessed
// wording. Read separately by agent.ts (the `rate_limit` error code) and turn-resume.ts, since a limit carries an
// instant to wait for.
// Read through the loaded SDK, not imported statically: a static import would pin these to the image's copy while the
// sentence being matched came from whatever CLI version actually ran.
export const isUsageLimitText = (text: string): boolean => sdk().USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));

// A credential the CLI has given up on: an expired token gets re-minted mid-turn (getOAuthToken), but one revoked or
// superseded by rotation still looks valid by the clock, so the CLI never reaches its refresh branch and prints this
// terminal prefix instead. Matched on the CLI's own prefix, not "401" or "revoked", since that's exactly when it has
// stopped retrying, not merely failed once.
const AUTH_FAILURE_PREFIX = "Failed to authenticate";

export const isAuthFailureText = (text: string): boolean => text.startsWith(AUTH_FAILURE_PREFIX);

// Engine too old for the model: the 400 carries both version numbers, but the CLI's "run claude update" advice is for a
// human at a terminal — engines/engines.ts performs the install instead. Matched on the floor clause, not the product
// name, which Anthropic is free to reword; the running version is useful for the card but never load-bearing.
const VERSION_FLOOR = /version\s+(\d+\.\d+\.\d+)\s+or\s+newer\s+is\s+required/i;
const RUNNING_VERSION = /Claude Code\s+(\d+\.\d+\.\d+)\s+does not support/i;

export interface VersionFloor {
    readonly floor: string;
    readonly running?: string;
}

export const versionFloorOf = (text: string): VersionFloor | undefined => {
    const floor = VERSION_FLOOR.exec(text)?.[1];
    if (floor === undefined) {
        return undefined;
    }
    const running = RUNNING_VERSION.exec(text)?.[1];
    return running === undefined ? { floor } : { floor, running };
};

// Neither condition is ever a name, subject, or anything a caller asked a model to produce; the one-shot seam and both
// naming guards read this, never a single member.
export const isFailureSentence = (text: string): boolean => isUsageLimitText(text) || isAuthFailureText(text);

// A model that answered the asker instead of the ask, nobody's failure. Everything asked through these seams is a noun
// phrase, so a question, a first-person reply, or an apology is about the request, not an answer; the phrase list
// catches a flat declarative the shape rules miss. Deliberately eager: a false positive costs one retry, a false
// negative is a permanent bad name or commit.
const DECLINE_OPENERS =
    /^(?:i|i'm|i am|i'd|i would|i've|my|we|sorry|apolog|unfortunately|please|could you|can you|to name|there(?:'s| is) (?:not|no)|without)\b/i;
const DECLINE_PHRASES = [
    "more context",
    "more information",
    "more detail",
    "not enough",
    "no context",
    "unable to",
    "cannot determine",
    "can't determine",
    "need to know",
    "clarify",
    "please provide",
    "please specify",
];

export const isDeclinedAnswer = (text: string): boolean => {
    const clean = text.trim();
    // Empty is not a decline, it is nothing, and every caller already treats it as nothing.
    if (clean === "") {
        return false;
    }
    return clean.includes("?") || DECLINE_OPENERS.test(clean) || DECLINE_PHRASES.some((phrase) => clean.toLowerCase().includes(phrase));
};

// A model answering about itself instead of writing the requested prose: a small model asked to name a session whose
// opening message is an identity question often answers with its own name instead. Catches bare model/vendor names
// without an action tag or context.
const SELF_IDENTITY_NAMES =
    /^(?:(?:i(?:'m| am)|this is)\s+)?(?:claude|anthropic|haiku|sonnet|opus|gpt|chatgpt|openai|gemini|google|grok|xai|kimi|moonshot|cursor|qwen|deepseek)(?:[\s-][\w.-]*)?$/i;

export const isSelfIdentityAnswer = (text: string): boolean => {
    const clean = text.trim();
    return clean !== "" && SELF_IDENTITY_NAMES.test(clean);
};

// A model that reached for a tool it doesn't have and wrote the reach down as prose, since OpenCode's Gemini rung
// prepends its own coding-agent prompt whose worked examples teach exactly that. Matched at the line start, and the
// whole line goes with it (the tail is the model continuing its imagined transcript); this also lets a real answer
// merely mention a tool call and still land.
const TOOL_NAMES = "tool_call|tool_calls|tool_code|tool_use|function_call|invoke";

// One line that is a stand-in: the bracketed idiom Gemini-family prompts demonstrate, or a tag with its whole payload
// on one line.
const STAND_IN_LINE = new RegExp(String.raw`^\s*(?:\[{1,2}\s*(?:${TOOL_NAMES})\b|<\/?(?:${TOOL_NAMES})\b)`, "iu");

// Block forms need the lines under them dropped too — why this is a loop, not a filter. Dropping just the opener would
// leave `glob('**')` standing as if the model had answered.
const CODE_FENCE = "```";
const BLOCK_OPEN = new RegExp(String.raw`^\s*(?:${CODE_FENCE}(?:tool_code|tool_call|tool_use)\b|<(?:${TOOL_NAMES})\b[^>]*>\s*$)`, "iu");
const BLOCK_CLOSE = new RegExp(String.raw`^\s*(?:${CODE_FENCE}|</(?:${TOOL_NAMES})>)\s*$`, "iu");

// The reply with every stand-in taken out: what remains is what the model wrote for the caller, if anything.
export const withoutToolCallStandIns = (text: string): string => {
    const kept: string[] = [];
    let inBlock = false;
    for (const line of text.split("\n")) {
        if (inBlock) {
            // The terminator goes with its block; an unterminated block swallows the rest, which is the safe direction.
            inBlock = !BLOCK_CLOSE.test(line);
            continue;
        }
        if (BLOCK_OPEN.test(line)) {
            inBlock = true;
            continue;
        }
        if (!STAND_IN_LINE.test(line)) {
            kept.push(line);
        }
    }
    return kept.join("\n").trim();
};

// Whether a reply is nothing but stand-ins. Also lets a title already stolen by one forfeit its rank (agents-registry
// promoteTitle) and be re-asked next turn (title-namer), the same self-heal a failure sentence gets.
export const isToolCallStandIn = (text: string): boolean => text.trim() !== "" && withoutToolCallStandIns(text) === "";

// Same condition as isUsageLimitText, for providers with no SDK prefix list (Kimi's 403 otherwise reaches us coded as a
// refused credential). Read wherever a refusal is described: the frame's code (error-frames.ts) and the durable refusal
// filed against the account (agent.routes.ts). "rate limit" stays excluded, since it also covers transient retries the
// CLI is still working through.
const SPENT_ALLOWANCE_PHRASES = ["usage limit", "quota", "billing cycle"];

export const mentionsSpentAllowance = (text: string): boolean =>
    isUsageLimitText(text) || SPENT_ALLOWANCE_PHRASES.some((phrase) => text.toLowerCase().includes(phrase));

// A connected, authenticating account whose organization disabled Claude Code for it — invisible before this, since it
// matched neither prefix above. Matched on phrase, not prefix, since this is the API's own prose reaching us through
// the CLI's error text; an unseen wording just falls through to a plain uncoded failure.
const NOT_ENTITLED_PHRASES = ["disabled claude subscription access", "claude code is not available"];

export const isEntitlementRefusalText = (text: string): boolean => NOT_ENTITLED_PHRASES.some((phrase) => text.toLowerCase().includes(phrase));

// A parameter nothing in this sandbox ever sends, refused as if the turn had asked for it: the provider's own default,
// rejected by the provider itself. Coded as an outage, unlike other 4xx (which stay uncoded, since re-sending a
// malformed request is a loop) — there's no request here to fix. Requires both a listed parameter and the shape of a
// refusal, so a mention of caching in ordinary prose isn't misread.
const UNSENT_PARAMETERS = ["prompt_cache_retention", "prompt_cache_options"];
const PARAMETER_REFUSAL_SHAPE = /invalid_parameter|invalid_request_error|unsupported parameter|unknown parameter|is not supported/i;

export const isUnsentParameterRefusalText = (text: string): boolean =>
    UNSENT_PARAMETERS.some((parameter) => text.toLowerCase().includes(parameter)) && PARAMETER_REFUSAL_SHAPE.test(text);
