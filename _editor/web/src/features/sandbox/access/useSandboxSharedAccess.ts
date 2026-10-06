import { computed, watch } from "vue";
import { SANDBOX_MEMBERS } from "../../../lib/queryKeys";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { activeSandboxId } from "../../../lib/activeSandbox";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// Whether /sandbox/access names more than one person; the agents board's Everyone/Mine row is meaningless alone.
export function useSandboxSharedAccess() {
    const { active } = useSandbox();
    const isOwner = computed(() => active.value?.role === `owner`);
    const { query } = useSandboxQuery({
        queryKey: SANDBOX_MEMBERS.of(),
        queryFn: () => sandboxRaw(`GET /members`),
        enabled: computed(() => isOwner.value),
    });
    // The answer once there is one: undefined while the sandbox list or the members read is still on its way.
    const known = computed<boolean | undefined>(() => {
        const role = active.value?.role;
        if (role === undefined) {
            return undefined;
        }
        if (role !== `owner`) {
            return true;
        }
        return query.isPending.value ? undefined : (query.data.value?.members.length ?? 0) > 0;
    });
    // THE LAST ANSWER STANDS IN UNTIL THIS ONE ARRIVES. Neither the sandbox list nor the members read survives a reload,
    // so a shared sandbox's board opened without its Everyone/Mine row and grew it a moment later, pushing every card
    // down: a layout shift on every start (0.23 of the /agents page's measured CLS). Remembered per sandbox, so the row
    // is there in the first frame whenever it was there last time.
    watch(known, (value) => {
        const id = activeSandboxId.value;
        if (value !== undefined && id !== undefined) {
            remember(id, value);
        }
    });
    const sharedAccess = computed(() => known.value ?? recall(activeSandboxId.value));
    return { sharedAccess };
}

const rememberedKey = (sandboxId: string): string => `intentic.sharedAccess.${sandboxId}`;

const recall = (sandboxId: string | undefined): boolean => {
    try {
        return sandboxId !== undefined && localStorage.getItem(rememberedKey(sandboxId)) === `1`;
        // allow(silent-catch): Unavailable local storage supplies no cached shared-access row; the live response decides.
    } catch {
        return false;
    }
};

const remember = (sandboxId: string, shared: boolean): void => {
    try {
        localStorage.setItem(rememberedKey(sandboxId), shared ? `1` : `0`);
        // allow(silent-catch): Denied storage disables only the cached first frame, never the access decision.
    } catch {
        // Unavailable storage costs the next start its first-frame row, nothing else.
    }
};
