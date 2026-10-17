// Refusal codes whose cause is latched on the conversation's own state (its persona, its identity.startIn) rather than
// a transient sandbox condition: every resend is refused identically, so the chat offers a new chat instead of a resend
// (the editor's held line, heldQueue.ts) and the fold's row never promises one, whether the conversation's queue holds
// the words or the sandbox kept the turn whole (transcript-fold's heldRow).
export const DETERMINISTIC_REFUSALS: ReadonlySet<string> = new Set(["agent-domain-refused"]);

export const isDeterministicRefusal = (code: string | undefined): boolean => code !== undefined && DETERMINISTIC_REFUSALS.has(code);

// The clause after a refusal that ran nothing (transcript-fold's heldRow). A turn somebody typed is held in its
// conversation's queue for another press; a turn that started itself — an automation, a loop, a watch wake — has no
// typed message and nobody watching, so promising a resend there names a composer the reader is not looking at. Neither
// version promises a retry: whether one comes is the scheduler's decision, not this row's to state. A deterministic
// refusal names the way on instead, since a resend would meet the same wall.
export const undeliveredClause = (unattended: boolean, deterministic: boolean): string => {
    if (unattended) {
        return `Nothing ran, and nothing is held: this run started on its own, so there is no message waiting to be sent again.`;
    }
    return deterministic
        ? `Your message was not delivered, and sending it again would be refused the same way. Start a new chat to carry on.`
        : `Your message was not delivered: it is held for you to send again.`;
};
