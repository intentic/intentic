import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";

/* THE CONDITIONS THE CLI REPORTS AS PROSE, and the question every site that treats model output as data has to
 * ask of a reply before using it.
 *
 * Two things end a turn without being anything the turn did: a spent subscription allowance, and a credential
 * the CLI has stopped trying to use. Neither arrives as a thrown error or under a category worth branching on
 *, each is filed under whatever the failing layer happened to pick, and each says what it is in a SENTENCE.
 * That makes the sentence the one reliable signal, and matching the CLI's own prefixes classification rather
 * than text-sniffing.
 *
 * They live in one file because their difference only matters to RECOVERY, one waits for a reset instant, the
 * other re-mints a token (turn-resume.ts branches on exactly that), while their sameness is what every other
 * caller needs: THIS TEXT IS NOT AN ANSWER. A caller that asked for a one-liner it will use as data (a commit
 * subject, a session title) has to refuse the family, not a member of it, because the family is the part that
 * grows. It grew once already: the naming path guarded the usage-limit sentence alone, the auth sentence
 * arrived unguarded, and four fleet cards ended up named "Failed to authenticate. API Error: 401 …" with the
 * prompt they were derived from overwritten. isFailureSentence is what a third member joins.
 */

/* A spent Claude allowance surfaces as "You've hit your session limit · resets 1:40pm (UTC)". The SDK publishes
 * the exact prefixes those sentences use, which is what keeps this from being a guess about wording.
 *
 * Read on its own by the stream normalizer (agent.ts, where it becomes the `rate_limit` error code) and by
 * turn-resume.ts, because a limit is the one failure here that carries an instant to wait for. */
export const isUsageLimitText = (text: string): boolean => USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));

/* A CREDENTIAL THE CLI HAS GIVEN UP ON, recognised by the sentence it says so with.
 *
 * The harness already hands the SDK a way to re-mint a token mid-turn (getOAuthToken in agent.ts), and for an
 * EXPIRED token that works: the CLI asks, takes the replacement, and carries on. It does not ask here. A token
 * that was superseded by a rotation, or revoked account-wide, still looks valid by the clock, so the CLI
 * never reaches its refresh branch ("OAuth session expired and could not be refreshed") and takes the terminal
 * one instead, printing `Failed to authenticate. API Error: 401 …` and telling a human to run /login. Inside
 * this harness there is no /login to run and nobody watching an unattended turn to run it, so the turn simply
 * dies mid-work with everything it had done still in its session.
 *
 * Matched on the CLI's own prefix rather than on "401" or the word "revoked": the prefix is what the CLI writes
 * when it has stopped trying, which is precisely the condition worth resuming, an API error the CLI is still
 * retrying must not be mistaken for one it has abandoned. */
const AUTH_FAILURE_PREFIX = "Failed to authenticate";

export const isAuthFailureText = (text: string): boolean => text.startsWith(AUTH_FAILURE_PREFIX);

// Neither condition is ever a name, a commit subject, or anything else a caller asked a model to produce, so
// this is the predicate the one-shot seam and both naming guards read, and no caller of them names a member.
export const isFailureSentence = (text: string): boolean => isUsageLimitText(text) || isAuthFailureText(text);

/* A MODEL THAT ANSWERED THE ASKER INSTEAD OF THE ASK, the third kind of reply that is not data, and the only
 * one here that is nobody's failure. The provider is healthy, the credential is good, the turn completed: the
 * model simply decided it could not do the job from what it was given and said so, politely, in the first
 * person.
 *
 * It reached us as a session title. A naming pass on a thin opening prompt came back with "I need more context
 * to name this session. What feature, surface, file, or system…", every guard above passed it, it is neither a
 * spent allowance nor a refused credential, and it was written down as the conversation's name at the highest
 * automatic rank, which made it final. The commit box then read that title, prefixed it, and filed `feat: i
 * need more context to name this session…` as a commit subject. One unguarded reply, two surfaces wrong.
 *
 * THE SHAPE IS THE SIGNAL, not the wording, because the wording is per-model and endless. Everything asked for
 * through these seams is a NOUN PHRASE, a name, a subject, a sentence about a diff, and none of them is
 * addressed to anybody. So a reply that asks a question, opens in the first person, or apologises is a reply
 * about the request rather than an answer to it. The phrase list underneath catches the models that decline in
 * a flat declarative ("not enough information to…") and would otherwise slip past both tests.
 *
 * DELIBERATELY EAGER. A false positive costs one pass: the caller writes nothing, the old value stands, and the
 * next turn asks again. A false negative is permanent, a name that outranks every later automatic source, or a
 * commit that goes into the history wearing a question. Given that trade, this leans toward refusing. */
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

/* A SPENT ALLOWANCE IN SOMEBODY ELSE'S WORDS, the same condition as isUsageLimitText, for the providers whose
 * wording the Claude Code SDK has no prefix list for.
 *
 * Kimi answers a spent Kimi Code plan with `403 You've reached your usage limit for this billing cycle`, and a
 * 403 is what the CLI prints its "Failed to authenticate" prefix over, so the frame reaches us coded as a
 * refused CREDENTIAL and the user is told to reconnect an account that is in perfect health. Every routed
 * provider can do this to us: the harness only knows Anthropic's vocabulary, and it is reading somebody else's.
 *
 * This decides how a refusal is DESCRIBED, where believing the code over the sentence is what puts the wrong
 * sentence on the screen, so it is read at both places a description comes from: the frame's code
 * (error-frames.ts, above the auth branch it would otherwise be mistaken for) and the durable refusal filed
 * against the account (agent.routes.ts).
 *
 * The PHRASES are the conservative half, and stay that way: "rate limit" is deliberately absent, because it
 * appears in the transient retries the CLI is still working through, and reading one of those as a spent plan
 * would park a turn that was about to succeed. What a turn does next still keys off the prefixes above, which
 * say what the CLI has stopped trying, something this cannot know. */
const SPENT_ALLOWANCE_PHRASES = ["usage limit", "quota", "billing cycle"];

export const mentionsSpentAllowance = (text: string): boolean =>
    isUsageLimitText(text) || SPENT_ALLOWANCE_PHRASES.some((phrase) => text.toLowerCase().includes(phrase));

/* A THIRD CONDITION, AND THE ONE THAT WAS INVISIBLE: the account is connected, its token authenticates, and the
 * organization it belongs to has turned Claude Code off for it. Anthropic answers the turn with "Your
 * organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or
 * ask your admin to enable access".
 *
 * It matched NEITHER predicate above, not a usage-limit prefix, and it does not start with "Failed to
 * authenticate", so the frame went out uncoded, nothing durable was written about it, and the only trace of a
 * seat that had been taken away was a red line in one chat. Meanwhile the plan's usage endpoint kept answering
 * (a seat governs Claude Code, not whether the plan publishes pools), so the account picker went on drawing a
 * fresh, confident ring over an account that could not run a single turn. That gap is what this exists to close.
 *
 * A PHRASE, not a prefix, and the difference is admitted rather than papered over: the two predicates above
 * match what the CLI itself writes when it has given up, which is why they can be exact. This sentence is the
 * API's own prose reaching us through the CLI's error text, so there is no prefix to anchor on, the same
 * position SPENT_ALLOWANCE_PHRASES is in, and the same answer. A wording we have not seen falls through to a
 * plain uncoded failure, which is exactly where it stood before; this list grows when one shows up. */
const NOT_ENTITLED_PHRASES = ["disabled claude subscription access", "claude code is not available"];

export const isEntitlementRefusalText = (text: string): boolean => NOT_ENTITLED_PHRASES.some((phrase) => text.toLowerCase().includes(phrase));

/* A PARAMETER NOBODY HERE SENT, refused as though the turn had asked for it, and the reason a 400 is not always
 * the request's fault.
 *
 * `400 prompt_cache_retention is not supported on this model` killed a ten-minute Codex turn at its last
 * request. Nothing in this sandbox sets that parameter: the CLI's own outgoing body was captured and does not
 * carry it, the field name appears nowhere in this repo, and the upstream answer to a request WITHOUT it comes
 * back carrying `"prompt_cache_retention":"24h"` anyway, which is the provider applying its own default and
 * then, for whichever model route it picked that minute, rejecting it. The proxy in front of it can do the same
 * on a path that forgets to strip the field (packs/translator.Dockerfile pins past that bug).
 *
 * SO IT IS A PROVIDER FAULT WEARING A CLIENT ERROR'S STATUS CODE, and that is the whole point of reading it
 * here. Every other 4xx is uncoded on purpose, because re-sending a malformed request on a timer is a loop
 * rather than a recovery. This one has no request to fix: the rejected parameter is not ours to remove, the same
 * send goes through moments later, and leaving it uncoded means a red line and a dead tab over a condition that
 * cleared by itself. Coded as an outage, it rides the breaker every transient provider failure already uses.
 *
 * NARROW BY CONSTRUCTION, both halves required: a parameter from the list below AND the shape of a refusal. The
 * list holds only parameters this sandbox demonstrably never sends, so a matching sentence cannot be about
 * anything the turn did; the shape test keeps a model that merely MENTIONS one (the CLI's own prompts discuss
 * prompt caching) from being read as a refusal. A wording not covered here falls through to the plain uncoded
 * failure it is today. */
const UNSENT_PARAMETERS = ["prompt_cache_retention", "prompt_cache_options"];
const PARAMETER_REFUSAL_SHAPE = /invalid_parameter|invalid_request_error|unsupported parameter|unknown parameter|is not supported/i;

export const isUnsentParameterRefusalText = (text: string): boolean =>
    UNSENT_PARAMETERS.some((parameter) => text.toLowerCase().includes(parameter)) && PARAMETER_REFUSAL_SHAPE.test(text);
