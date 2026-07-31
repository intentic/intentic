import { USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";

/* THE CONDITIONS THE CLI REPORTS AS PROSE, and the question every site that treats model output as data has to
 * ask of a reply before using it.
 *
 * Two things end a turn without being anything the turn did: a spent subscription allowance, and a credential
 * the CLI has stopped trying to use. Neither arrives as a thrown error or under a category worth branching on
 * — each is filed under whatever the failing layer happened to pick, and each says what it is in a SENTENCE.
 * That makes the sentence the one reliable signal, and matching the CLI's own prefixes classification rather
 * than text-sniffing.
 *
 * They live in one file because their difference only matters to RECOVERY — one waits for a reset instant, the
 * other re-mints a token (turn-resume.ts branches on exactly that) — while their sameness is what every other
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
 * that was superseded by a rotation — or revoked account-wide — still looks valid by the clock, so the CLI
 * never reaches its refresh branch ("OAuth session expired and could not be refreshed") and takes the terminal
 * one instead, printing `Failed to authenticate. API Error: 401 …` and telling a human to run /login. Inside
 * this harness there is no /login to run and nobody watching an unattended turn to run it, so the turn simply
 * dies mid-work with everything it had done still in its session.
 *
 * Matched on the CLI's own prefix rather than on "401" or the word "revoked": the prefix is what the CLI writes
 * when it has stopped trying, which is precisely the condition worth resuming — an API error the CLI is still
 * retrying must not be mistaken for one it has abandoned. */
const AUTH_FAILURE_PREFIX = "Failed to authenticate";

export const isAuthFailureText = (text: string): boolean => text.startsWith(AUTH_FAILURE_PREFIX);

// Neither condition is ever a name, a commit subject, or anything else a caller asked a model to produce — so
// this is the predicate the one-shot seam and both naming guards read, and no caller of them names a member.
export const isFailureSentence = (text: string): boolean => isUsageLimitText(text) || isAuthFailureText(text);
