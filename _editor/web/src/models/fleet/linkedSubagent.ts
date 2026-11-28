import type { SubagentSession } from "@intentic/sandbox-contract/schemas/terminal";
import { contactsHrefIn, linkedSandboxesHref } from "../sandbox/sandboxNav";

// A task this sandbox handed to another of the owner's sandboxes over a link: a subagent row here whose conversation
// lives over there. Its row opens that conversation in the other sandbox (`/?sandbox=<id>&conversation=<id>`, which the
// router's arrival rule turns into a switch to that sandbox), in a window of its own so this one stays where it was.
// While it waits for that sandbox's owner to let it start, there is no conversation to read yet: the row opens the
// Linked sandboxes section of that sandbox's Access page instead, where its Allow and Decline are; one handed to a
// contact (`contact`, 2026-11-27) waits on that sandbox's Messages ▸ Contacts, at the top. One handed over as the person
// (`via: "person"`, 2026-11-24) never waits there: it is that person's own conversation, which they read in that
// sandbox, so its row always opens it.

/** The address a linked task's row opens in its own sandbox; undefined for any other row, or one whose sandbox is unknown. */
export const linkedConversationHref = (session: Pick<SubagentSession, "kind" | "linked" | "status">): string | undefined => {
    const far = session.kind === `linked` ? session.linked : undefined;
    if (far?.sandboxId === undefined) {
        return undefined;
    }
    if (session.status === `pending` && far.via !== `person`) {
        return far.contact === undefined ? linkedSandboxesHref(far.sandboxId) : contactsHrefIn(far.sandboxId);
    }
    return `/?${new URLSearchParams({ sandbox: far.sandboxId, conversation: far.conversationId }).toString()}`;
};

/** Opens a linked task where it runs; false for a row that is not one, or whose sandbox is unknown. */
export const openLinkedSubagent = (session: Pick<SubagentSession, "kind" | "linked" | "status">): boolean => {
    const href = linkedConversationHref(session);
    if (href === undefined) {
        return false;
    }
    window.open(href, `_blank`, `noopener`);
    return true;
};
