import { computed } from "vue";
import { SANDBOX_MEMBERS } from "../../../lib/queryKeys";
import { sandboxJson } from "../client/sandboxClient";
import { useSandbox } from "../client/useSandbox";
import { useSandboxQuery } from "../client/useSandboxQuery";

type MembersRoster = { members: { email: string }[]; owner?: string };

// Whether /sandbox/access names more than one person; the agents board's Everyone/Mine row is meaningless alone.
export function useSandboxSharedAccess() {
    const { active } = useSandbox();
    const isOwner = computed(() => active.value?.role === `owner`);
    const { query } = useSandboxQuery({
        queryKey: SANDBOX_MEMBERS.of(),
        queryFn: async (): Promise<MembersRoster> => (await sandboxJson(`/members`)) as MembersRoster,
        enabled: computed(() => isOwner.value),
    });
    const sharedAccess = computed(() => {
        const role = active.value?.role;
        if (role !== undefined && role !== `owner`) {
            return true;
        }
        if (!isOwner.value || query.isPending.value) {
            return false;
        }
        return (query.data.value?.members.length ?? 0) > 0;
    });
    return { sharedAccess };
}
