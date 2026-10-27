import type { Need } from "@intentic/sandbox-contract/schemas/needs";
import { computed, type ComputedRef } from "vue";
import { useAccess } from "../../client/sandbox/access/useAccess";
import { useSandboxSession } from "../../client/session/sandboxSession";

// WHETHER THE READER MAY ANSWER A NEED, and who it waits on when they may not. Answering is a maintainer's (the
// `needs.answer` floor), so anyone below reads the need without its answers and is told who it waits on rather than
// "you". A release is the exception: the people its gate names answer it, whatever their tier.

/** Who answers a need the reader may not, as the words name them. */
export type NeedWaiter = `owner` | `maintainer`;

export interface NeedReach {
    /** Whether the reader may answer this need. */
    readonly mayAnswer: (need: Need) => boolean;
    /** Who answers the needs the reader may not. */
    readonly waiter: ComputedRef<NeedWaiter>;
}

export const useNeedReach = (): NeedReach => {
    const access = useAccess();
    const { presentedEmail } = useSandboxSession();
    // Until the reader's access is known nothing is refused, as before: the daemon still decides.
    const answers = computed(() => !access.known.value || access.can(`needs.answer`));
    const waiter = computed((): NeedWaiter => {
        const reason = access.refusal(`needs.answer`);
        return reason?.kind === `tier` && reason.floor === `owner` ? `owner` : `maintainer`;
    });
    return {
        mayAnswer: (need) => {
            if (need.subject.kind !== `release`) {
                return answers.value;
            }
            // A courtesy only: the daemon checks the verified identity against the gate, yes or no.
            const me = presentedEmail.value?.toLowerCase();
            return me === undefined || need.subject.approvers.some((approver) => approver.toLowerCase() === me);
        },
        waiter,
    };
};
