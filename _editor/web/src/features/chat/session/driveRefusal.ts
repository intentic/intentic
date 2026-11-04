import { computed, type ComputedRef } from "vue";
import type { AccessReason } from "../../../client/sandbox/access/accessReason";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { useRole } from "../../../client/sandbox/useRole";
import { agentById } from "../../../models/fleet/useAgents-fleet";
import { firstName, readOnlyUntil, sealAuthor } from "../../../models/agent-status/sealView";

// WHY THE READER CANNOT DRIVE A CHAT HERE (a viewer, a writer with running agents off), or undefined when they can. A
// chat surface reads it to draw a quiet "you can follow along" in place of every press that would answer or steer the
// agent, rather than presses the daemon only refuses. A guest drives its own chats and is never refused here. The reason
// is the daemon's own check on a reply (useAccess); until that check has loaded, the tier alone (useRole.canDrive).
// Given the conversation, a private one the reader was shown for a day or opened without asking is read-only too, whatever
// their tier: nothing they press may write into it (schemas/seal.ts `via`).
export const useDriveRefusal = (conversationId?: () => string): ComputedRef<AccessReason | undefined> => {
    const access = useAccess();
    const { canDrive, isGuest } = useRole();
    return computed((): AccessReason | undefined => {
        const card = conversationId === undefined ? undefined : agentById(conversationId());
        const until = readOnlyUntil(card);
        if (until !== undefined) {
            return { kind: `sealed`, until, author: firstName(sealAuthor(card?.seal)) };
        }
        if (isGuest.value) {
            return undefined;
        }
        const refused = access.refusal(`agent.reply`);
        if (refused !== undefined || canDrive.value) {
            return refused;
        }
        return { kind: `tier`, floor: `collaborator` };
    });
};
