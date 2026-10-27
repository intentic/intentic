import { computed, type ComputedRef } from "vue";
import type { AccessReason } from "../../../client/sandbox/access/accessReason";
import { useAccess } from "../../../client/sandbox/access/useAccess";
import { useRole } from "../../../client/sandbox/useRole";

// WHY THE READER CANNOT DRIVE A CHAT HERE (a viewer, a writer with running agents off), or undefined when they can. A
// chat surface reads it to draw a quiet "you can follow along" in place of every press that would answer or steer the
// agent, rather than presses the daemon only refuses. A guest drives its own chats and is never refused here. The reason
// is the daemon's own check on a reply (useAccess); until that check has loaded, the tier alone (useRole.canDrive).
export const useDriveRefusal = (): ComputedRef<AccessReason | undefined> => {
    const access = useAccess();
    const { canDrive, isGuest } = useRole();
    return computed((): AccessReason | undefined => {
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
