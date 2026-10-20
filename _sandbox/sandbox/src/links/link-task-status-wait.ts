// What a held link status read waits on: a nudge for its conversation, sent by whatever can move the status (the store's
// moveTask, the run parking on a card, an answer settling a question), instead of a store re-read every second
// (2026-10-20). Each conversation keeps a count of its nudges, so a nudge that arrives between the read and the wait is
// not lost: the wait starts from the count the read saw and returns at once if it has moved.

const nudges = new Map<string, number>();
const waiters = new Map<string, Set<() => void>>();

/** The conversation's nudge count; read it before reading the status a wait will compare against. */
export const linkTaskStatusMark = (conversationId: string): number => nudges.get(conversationId) ?? 0;

/** Wakes every status read held on this conversation. */
export const wakeLinkTaskStatus = (conversationId: string): void => {
    // Counted even with nobody held: a read may be between its look and its wait. One number per linked conversation.
    nudges.set(conversationId, linkTaskStatusMark(conversationId) + 1);
    // oxlint-disable-next-line unicorn/no-useless-spread -- The spread snapshots the waiters, each of which removes itself.
    for (const wake of [...(waiters.get(conversationId) ?? [])]) {
        wake();
    }
};

/** Resolves on a nudge after `mark`, on abort, or at `deadline` (which may be past), whichever comes first. */
export const waitForLinkTaskStatus = (conversationId: string, mark: number, signal: AbortSignal, deadline: number): Promise<void> =>
    new Promise((resolve) => {
        if (signal.aborted || linkTaskStatusMark(conversationId) !== mark) {
            resolve();
            return;
        }
        let set = waiters.get(conversationId);
        if (set === undefined) {
            set = new Set();
            waiters.set(conversationId, set);
        }
        const held = set;
        const finish = (): void => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            held.delete(finish);
            if (held.size === 0) {
                waiters.delete(conversationId);
            }
            resolve();
        };
        held.add(finish);
        const timer = setTimeout(finish, Math.max(0, deadline - Date.now()));
        signal.addEventListener("abort", finish, { once: true });
    });
