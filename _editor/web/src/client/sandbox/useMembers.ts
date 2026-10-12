import type { MemberGrant, MembersList, MembersRoster } from "@intentic/sandbox-contract";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { invalidatePushedQueries } from "../../lib/pushInvalidation";
import { SANDBOX_MEMBERS } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { sandboxRaw } from "./sandboxRaw";
import { useSandboxQuery } from "./useSandboxQuery";

// THE DAEMON'S MEMBER ROSTER, READ AND WRITTEN IN ONE PLACE. It is the one copy that knows each member's fence, and it
// is read by the Access tab, the agents board's Everyone/Mine row and the credential gates' approver list, all through
// the one cache entry below. A write answers the roster after it, which lands in that entry whole, so every reader of
// it moves with the write whether or not the tab that made it is still up, and nothing keeps a copy of its own.

// `enabled` is for a reader that is only allowed to ask at some tiers: the roster is the owner's to read, and a member
// asking would be refused.
export function useMembers(options: { readonly enabled?: MaybeRefOrGetter<boolean> } = {}) {
    const { query, error } = useSandboxQuery({
        queryKey: SANDBOX_MEMBERS.of(),
        queryFn: () => sandboxRaw(`GET /members`),
        enabled: computed(() => toValue(options.enabled ?? true)),
    });
    return {
        query,
        // Why it could not be read, said in words; undefined while it can. The last good roster stays in `roster`.
        error,
        roster: computed<MembersRoster | undefined>(() => query.data.value),
        members: computed(() => query.data.value?.members ?? []),
        owner: computed(() => query.data.value?.owner),
    };
}

// Puts a write's answer into the cache. The answer holds the members and not the owner, an identity fact the roster file
// never carries, so the owner a read already found is kept; with no read yet there is nothing to complete, and the
// next one fills the whole roster in. A read still on its way is asked again once it lands, as the daemon's pushes are:
// what it carries may predate this write.
const adopt = async (answer: MembersList): Promise<MembersList> => {
    const key = SANDBOX_MEMBERS.of();
    const before = queryClient.getQueryData<MembersRoster>(key);
    if (before === undefined) {
        void invalidatePushedQueries(queryClient, { queryKey: key });
        return answer;
    }
    // A refresh already in flight started before this write: let it go, or it would land over the roster just adopted.
    await queryClient.cancelQueries({ queryKey: key });
    queryClient.setQueryData<MembersRoster>(key, (current) => ({ ...(current ?? before), members: answer.members }));
    return answer;
};

// A grant replaces the person's whole row, areas included, so a caller sends the fence it means to keep.
export const grantMember = async (grant: MemberGrant): Promise<MembersList> => adopt(await sandboxRaw(`POST /members`, { input: grant }));

export const revokeMember = async (email: string): Promise<MembersList> => adopt(await sandboxRaw(`DELETE /members`, { input: { email } }));
