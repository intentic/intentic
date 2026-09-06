import type { LimitResetClaim, LimitResetStatus } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { sandboxJsonVia } from "../../sandbox/client/sandboxClient";

/* THE WAY PAST A SPENT SESSION WINDOW THAT IS NOT WAITING FOR IT, on the client side: what the provider says
 * about one account, and the press that spends it.
 *
 * Anthropic reopens a spent five-hour window on demand, once a week per account, leaving the WEEKLY allowance
 * exactly where it was. So the commonest refusal in this app — a session pool at 100% with a weekly pool a
 * third full — has an answer that costs nothing but a grant the user is already paying for, and until now the
 * only thing on screen was a countdown. (claude-limit-reset.ts on the daemon side has the mechanism, and why
 * the answer is the provider's rather than something to infer from a 100% meter.)
 *
 * ASKED ONCE PER ACCOUNT, and never on a timer. The daemon's probe tells the provider the account is at the
 * wall, which is a claim about the account and is only true while a refusal is on screen; the endpoint behind
 * it also rate limits reads hard enough that a poller would cost the meters next door their freshness. One
 * strip appearing asks once, several strips for the same account share that one answer, and nothing re-asks
 * until a claim has actually changed something.
 *
 * A FAILED ASK IS NOT AN ANSWER, and is deliberately not cached as one: the entry stays absent, so the next
 * strip for that account tries again, whereas a cached "unavailable" would suppress a real grant for the life
 * of the page. Absent and "not available" render identically (no button), so this costs nothing on screen. */

const answers = ref(new Map<string, LimitResetStatus>());
// One request per account however many strips ask at once. Keyed the same as the answers, and cleared as each
// settles, so a retry after a failure is a fresh request rather than a joined dead one.
const asking = new Map<string, Promise<void>>();

/** What the provider said about this account, or undefined while nobody has asked or the ask failed. */
export const limitResetFor = (account: string | undefined): LimitResetStatus | undefined =>
    account === undefined ? undefined : answers.value.get(account);

/* Ask, unless this account has been asked already. `at` is the sandbox the conversation is homed in, because a
 * conversation on another box holds its accounts over there: asking the box in front of the user about an
 * account it does not have would answer "no grant" about a perfectly eligible connection.
 *
 * Hands back the request it joined or started, which no caller in the app needs — a strip renders off the map
 * above and does not wait for anything. It is here because "the answer is not cached and the entry is gone"
 * are two states one settle apart, and a caller with no way to await the settle can only distinguish them by
 * sleeping. Returning it costs nothing and makes that observable. */
export const askLimitReset = async (account: string | undefined, at?: string): Promise<void> => {
    if (account === undefined || answers.value.has(account)) {
        return;
    }
    const joined = asking.get(account);
    if (joined !== undefined) {
        return joined;
    }
    const request = sandboxJsonVia<LimitResetStatus>(at, `/usage/limit-reset/${encodeURIComponent(account)}`)
        .then((status) => {
            answers.value.set(account, status);
        })
        .catch(() => {
            // Left unanswered on purpose, see the header: an unreachable daemon must not become a durable "no".
        })
        .finally(() => {
            asking.delete(account);
        });
    asking.set(account, request);
    return request;
};

/* Spend the grant.
 *
 * WHETHER THE OFFER SURVIVES THE PRESS depends on what the press proved. A claim that reset the window, or that
 * the provider answered about the account (`already_used`, `ineligible`, `not_limited`), has just made the
 * cached "available" false or moot, and leaving the button up would invite a second press that cannot work. A
 * claim that never got an answer, a 429, a 503, an unreachable daemon, proves nothing about the grant and
 * spent nothing, so the offer stands and the press stays available: an error that removes the only way to
 * retry it is the worst of the two mistakes here. */
const RETRYABLE = new Set([`unavailable`, `error`]);

export const claimLimitReset = async (account: string, at?: string): Promise<LimitResetClaim> => {
    const claim = await sandboxJsonVia<LimitResetClaim>(at, `/usage/limit-reset/${encodeURIComponent(account)}/claim`, jsonBody(`POST`, {})).catch(
        (): LimitResetClaim => ({ result: `error`, detail: `Your sandbox didn't answer.` }),
    );
    if (!RETRYABLE.has(claim.result)) {
        answers.value.delete(account);
    }
    return claim;
};

/* WHAT A CLAIM THAT CHANGED NOTHING SAYS, one short line each, because they are read by somebody who has just
 * pressed a button and is owed the difference between "come back next week" and "try that again".
 *
 * `reset` has no line: the window is open and the turn is already going again, which is the answer. */
export const limitResetNote = (claim: LimitResetClaim): string => {
    switch (claim.result) {
        case `reset`:
            return ``;
        case `already_used`:
            return `This week's reset is already spent.`;
        case `not_limited`:
            return `The window had already reopened — just continue.`;
        case `ineligible`:
            return `This account's plan doesn't include a reset.`;
        default:
            return claim.detail ?? `Couldn't reset it right now — try again in a moment.`;
    }
};
