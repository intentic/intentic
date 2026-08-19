/* HAS THIS TURN TAKEN IN CONTENT FROM OUTSIDE? — one bit, held for the life of one turn, and the thing that
 * makes the outside-content envelope more than a label.
 *
 * The envelope tells the MODEL what it is reading. This tells the GATE, which is the half that does not depend
 * on the model choosing to believe its instructions. The attack the pair exists to break has three links —
 * outside text arrives, the agent is talked into reading a credential, the credential leaves — and the middle
 * one is the only place a policy can stand: the first link is the product working (a Front Desk that refuses
 * strangers is not a Front Desk), and by the third the value is already in a process's argv.
 *
 * SET TWO WAYS, both of them "content the owner did not write entered this turn":
 *   · at birth, for a wake a stranger caused — a listener message, a webchat visitor (automations/scheduler.ts
 *     asks wakeSourceOf, the same question the admission floor asks);
 *   · mid-turn, the first time a result is actually wrapped (guard/outside-results.ts) — a fetched page, a
 *     foreign MCP server's answer, the output of a curl that reached the internet.
 *
 * ONE-WAY on purpose. There is no clearing it: a turn that has read a hostile page is a turn whose later
 * reasoning may be that page's, and "the page was three tool calls ago" is not evidence of anything. It dies
 * with the turn, which is the correct lifetime — the next turn starts clean unless it too takes something in.
 *
 * WHAT IT DOES is deliberately narrow (guard/command-gate.ts): while set, commands that READ CREDENTIAL
 * MATERIAL stop being auto-allowed. Not a lockdown — the agent still edits, builds, runs tests, and answers
 * the stranger who woke it. The owner's own rule still wins in both directions: an explicit `allow` on that
 * class means they have said this workspace does not want the floor, and an explicit `deny` outranks it
 * anyway. */

export interface TurnTaint {
    // Whether outside content has entered this turn.
    readonly tainted: () => boolean;
    // What first brought it in — named on the permission card, so the owner is told WHY they are being asked
    // rather than merely that they are. The FIRST source sticks: it is the one that could have planted the
    // instruction, and a later page does not make the story clearer.
    readonly source: () => string | undefined;
    // Called by the seams. Idempotent; only the first call records a source.
    readonly mark: (source: string) => void;
}

export const createTurnTaint = (born?: string): TurnTaint => {
    let source = born;
    return {
        tainted: () => source !== undefined,
        source: () => source,
        mark: (from: string) => {
            source ??= from;
        },
    };
};

// A turn that can never be tainted — the shape callers use where no taint is tracked (a bench turn, a helper
// one-shot). Its own object rather than `undefined` so consult sites stay branch-free.
export const NO_TAINT: TurnTaint = { tainted: () => false, source: () => undefined, mark: () => {} };

/* THE LIVE TURNS' BITS, BY CONVERSATION — so a consult site OUTSIDE the turn generator can ask the same
 * question the command gate asks from inside it.
 *
 * There is exactly one such site today and it is the one that most needs the answer: the wallet's payment
 * gate (wallet/payment-offer.ts) runs in the daemon's HTTP layer, because the agent's `wallet fetch` arrives
 * as a request while its turn sits inside a Bash tool. A turn that has read a hostile page must not be able
 * to spend on the owner's standing auto-approve delegation — that band was granted for the agent's own
 * judgment, and a fetched page is exactly what replaces it — so the band is suspended while this bit is set
 * and the payment asks in chat instead. Nothing else changes: the wallet still works, the caps still hold.
 *
 * A conversation's entry is replaced when its next turn mints one and cleared when the turn settles (wired
 * in composition.ts). If a provider ever ran a turn without minting one, the stale entry would make the next
 * turn ask MORE often rather than less — the safe direction, deliberately. */
const live = new Map<string, TurnTaint>();

export const publishTurnTaint = (conversationId: string, taint: TurnTaint): void => {
    live.set(conversationId, taint);
};

export const clearTurnTaint = (conversationId: string): void => {
    live.delete(conversationId);
};

// Whether the live turn in this conversation has taken in outside content. Unknown conversation ⇒ false: no
// turn of ours is running there, and the payment gate's own "is there a live run" check is what refuses that.
export const conversationTainted = (conversationId: string): boolean => live.get(conversationId)?.tainted() ?? false;
