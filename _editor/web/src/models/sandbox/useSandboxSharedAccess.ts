import { computed, watch } from "vue";
import { useMembers } from "../../client/sandbox/useMembers";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { activeSandboxId } from "../../app/storage/activeSandbox";
import { sharedAccessKey, storedValue, storeValue } from "../../app/storage/browserStorage";

// Whether /sandbox/access names more than one person; the agents board's Everyone/Mine row is meaningless alone. Only
// the owner has to read the roster to know: anyone else is on it, beside the owner, which already makes two, whatever
// they may manage.
export function useSandboxSharedAccess() {
    const { active } = useSandbox();
    const isOwner = computed(() => active.value?.role === `owner`);
    const { query } = useMembers({ enabled: isOwner });
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

// The account's own answer (a member is always one of two, an owner reads its roster), so in its drawer.
const recall = (sandboxId: string | undefined): boolean => sandboxId !== undefined && storedValue(sharedAccessKey(sandboxId)) === `1`;

// Storage that refuses the write costs the next start its first-frame row, nothing else.
const remember = (sandboxId: string, shared: boolean): void => storeValue(sharedAccessKey(sandboxId), shared ? `1` : `0`);
