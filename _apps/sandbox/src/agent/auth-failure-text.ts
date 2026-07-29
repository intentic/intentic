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
 * Which makes the sentence itself the only signal, exactly as it is for a spent usage allowance
 * (usage-limit-text.ts). Matched on the CLI's own prefix rather than on "401" or the word "revoked": the
 * prefix is what the CLI writes when it has stopped trying, which is precisely the condition worth resuming —
 * an API error the CLI is still retrying must not be mistaken for one it has abandoned.
 */
const AUTH_FAILURE_PREFIX = "Failed to authenticate";

export const isAuthFailureText = (text: string): boolean => text.startsWith(AUTH_FAILURE_PREFIX);
