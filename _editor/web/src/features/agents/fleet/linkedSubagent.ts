import type { SubagentSession } from "@intentic/sandbox-contract";

// A task this sandbox handed to another of the owner's sandboxes over a link: a subagent row here whose conversation
// lives over there. Its row opens that conversation in the other sandbox (`/?sandbox=<id>&conversation=<id>`, which the
// router's arrival rule turns into a switch to that sandbox), in a window of its own so this one stays where it was.

/** The address of a linked task's conversation in its own sandbox; undefined for any other row, or one whose sandbox is unknown. */
export const linkedConversationHref = (session: Pick<SubagentSession, "kind" | "linked">): string | undefined => {
    const far = session.kind === `linked` ? session.linked : undefined;
    if (far?.sandboxId === undefined) {
        return undefined;
    }
    return `/?${new URLSearchParams({ sandbox: far.sandboxId, conversation: far.conversationId }).toString()}`;
};

/** Opens a linked task where it runs; false for a row that is not one, or whose sandbox is unknown. */
export const openLinkedSubagent = (session: Pick<SubagentSession, "kind" | "linked">): boolean => {
    const href = linkedConversationHref(session);
    if (href === undefined) {
        return false;
    }
    window.open(href, `_blank`, `noopener`);
    return true;
};
