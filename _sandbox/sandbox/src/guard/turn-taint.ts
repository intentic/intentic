/* HAS THIS TURN TAKEN IN CONTENT FROM OUTSIDE?, one bit, held for the life of one turn, and the thing that
 * makes the outside-content envelope more than a label.
 *
 * The envelope tells the MODEL what it is reading. This tells the GATE, which is the half that does not depend
 * on the model choosing to believe its instructions. The attack the pair exists to break has three links,
 * outside text arrives, the agent is talked into reading a credential, the credential leaves, and the middle
 * one is the only place a policy can stand: the first link is the product working (a Front Desk that refuses
 * strangers is not a Front Desk), and by the third the value is already in a process's argv.
 *
 * SET TWO WAYS, both of them "content the owner did not write entered this turn":
 *   · at birth, for a wake a stranger caused, a listener message, a webchat visitor (automations/scheduler.ts
 *     asks wakeSourceOf, the same question the admission floor asks);
 *   · mid-turn, the first time a result is actually wrapped (guard/outside-results.ts), a fetched page, a
 *     foreign MCP server's answer, the output of a curl that reached the internet.
 *
 * ONE-WAY on purpose. There is no clearing it: a turn that has read a hostile page is a turn whose later
 * reasoning may be that page's, and "the page was three tool calls ago" is not evidence of anything. It dies
 * with the turn, which is the correct lifetime, the next turn starts clean unless it too takes something in.
 *
 * WHAT IT DOES, and this is the part that changed with the safety redesign: it is EVIDENCE, not a verdict.
 * The bit used to be a hard-coded floor — while set, a recursive delete was held, and so was a credential read
 * that left in the same command. Both of those were fixed judgments about what a fetched page MEANS, made in
 * code, with no way for an owner to narrow or widen them. Now the bit (and the source that set it) is handed to
 * the command judge as one fact among several (agent/command-judge.ts JudgeFacts), and what to do about it is a
 * sentence in the owner's own policy: the shipped default says to be stricter about deletes and outbound sends
 * on a tainted turn, which is where those two floors went, and an owner who disagrees edits a paragraph instead
 * of arguing with a switch.
 *
 * It is still narrow either way. The agent goes on editing, building, running tests and answering the stranger
 * who woke it; nothing about this bit is a lockdown. And it is read by two consult sites OUTSIDE any turn
 * generator, which is why it is published rather than merely held: the wallet's payment gate, and the host
 * bridge judging a command headed for one of the owner's own computers. */

export interface TurnTaint {
    // Whether outside content has entered this turn.
    readonly tainted: () => boolean;
    // What first brought it in, named on the permission card, so the owner is told WHY they are being asked
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

// A turn that can never be tainted, the shape callers use where no taint is tracked (a bench turn, a helper
// one-shot). Its own object rather than `undefined` so consult sites stay branch-free.
export const NO_TAINT: TurnTaint = { tainted: () => false, source: () => undefined, mark: () => {} };

/* THE LIVE TURNS' BITS, BY CONVERSATION, so a consult site OUTSIDE the turn generator can ask the same
 * question the command gate asks from inside it.
 *
 * There is exactly one such site today and it is the one that most needs the answer: the wallet's payment
 * gate (wallet/payment-offer.ts) runs in the daemon's HTTP layer, because the agent's `wallet fetch` arrives
 * as a request while its turn sits inside a Bash tool. A turn that has read a hostile page must not be able
 * to spend on the owner's standing auto-approve delegation, that band was granted for the agent's own
 * judgment, and a fetched page is exactly what replaces it, so the band is suspended while this bit is set
 * and the payment asks in chat instead. Nothing else changes: the wallet still works, the caps still hold.
 *
 * A conversation's entry is replaced when its next turn mints one and cleared when the turn settles (wired
 * in composition.ts). If a provider ever ran a turn without minting one, the stale entry would make the next
 * turn ask MORE often rather than less, the safe direction, deliberately. */
const live = new Map<string, TurnTaint>();

/* WHETHER ANYBODY IS WATCHING THE LIVE TURN, published beside the bit and for the same reason: a consult site
 * outside the generator needs it and cannot derive it.
 *
 * There is exactly one such site, and it arrived with the host bridge (hosts/host.routes.ts): a `run_command`
 * headed for the owner's own computer is judged in the daemon's HTTP layer, before it crosses the tunnel, while
 * the turn that asked for it sits inside an MCP tool call. The judge is told whether anyone is watching because
 * the owner's policy has a section about exactly that, and because a verdict of `ask` on an unattended turn
 * becomes a refusal — deciding that from a guess would be deciding it wrong on every automation.
 *
 * Defaults to UNATTENDED for a conversation with no live turn. That is the safe direction and it is also the
 * true one: no turn of ours is running there, so there is certainly nobody watching one. */
const attended = new Set<string>();

export const publishTurnTaint = (conversationId: string, taint: TurnTaint, unattended = false): void => {
    live.set(conversationId, taint);
    if (unattended) {
        attended.delete(conversationId);
    } else {
        attended.add(conversationId);
    }
};

export const clearTurnTaint = (conversationId: string): void => {
    live.delete(conversationId);
    attended.delete(conversationId);
};

export const conversationUnattended = (conversationId: string): boolean => !attended.has(conversationId);

// Whether the live turn in this conversation has taken in outside content. Unknown conversation ⇒ false: no
// turn of ours is running there, and the payment gate's own "is there a live run" check is what refuses that.
export const conversationTainted = (conversationId: string): boolean => live.get(conversationId)?.tainted() ?? false;

// What first brought outside content into the live turn, for a consult site outside the generator that wants
// to NAME the source rather than only know the bit (the child service's spawn floor).
export const conversationTaintSource = (conversationId: string): string | undefined => live.get(conversationId)?.source();

/* Mark the live turn's taint from OUTSIDE the generator — the child service's composition seam. A child on a
 * runtime whose rulebook axis is "none" runs beyond every gate this daemon has, so the parent that started it
 * (and will read its report) has taken in content no policy could see; the safe direction is the parent's own
 * credential floor engaging, exactly as it does for a fetched page. No live turn (a CLI spawn after the turn
 * ended) is a no-op: the bit is per-turn by design and there is no turn to protect. */
export const markConversationTaint = (conversationId: string, source: string): void => {
    live.get(conversationId)?.mark(source);
};

