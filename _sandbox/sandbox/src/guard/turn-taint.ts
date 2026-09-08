// One bit for the life of a turn: whether outside content has entered it, evidence for the judge rather than a verdict
// itself. Set at birth (a stranger's wake) or mid-turn (the first wrapped result); one-way, and dies with the turn.
// Published, since two consult sites outside the generator need it: the wallet's payment gate and the host bridge.

export interface TurnTaint {
    // Whether outside content has entered this turn.
    readonly tainted: () => boolean;
    // First source sticks, named on the card: it's the one that could have planted an instruction.
    readonly source: () => string | undefined;
    // Called by the seams; idempotent, only the first call records a source.
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

// A turn that never taints (bench run, helper one-shot); its own object keeps consult sites branch-free.
export const NO_TAINT: TurnTaint = { tainted: () => false, source: () => undefined, mark: () => {} };

// Live turns' taint bits by conversation, for consult outside the generator (the wallet's payment gate). Replaced each
// turn, cleared on settle; a stale entry only asks more, the safe direction.
const live = new Map<string, TurnTaint>();

// Whether anybody is watching the live turn, published for the host bridge's own outside-generator judge call. Defaults
// to unattended for a conversation with no live turn, both safe and true.
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

// Whether the live turn in this conversation has taken in outside content; unknown conversation reads false.
export const conversationTainted = (conversationId: string): boolean => live.get(conversationId)?.tainted() ?? false;

// What first brought outside content into the live turn, for a caller that wants to name the source.
export const conversationTaintSource = (conversationId: string): string | undefined => live.get(conversationId)?.source();

// Marks the live turn's taint from outside the generator (the child service's composition seam): a child beyond every
// gate taints its parent too. No live turn is a no-op.
export const markConversationTaint = (conversationId: string, source: string): void => {
    live.get(conversationId)?.mark(source);
};

