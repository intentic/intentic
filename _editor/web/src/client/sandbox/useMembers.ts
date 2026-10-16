import type { AgentAccess, MemberGrant, MemberSelf, MembersList, MembersRoster } from "@intentic/sandbox-contract/schemas/members";
import { computed, type ComputedRef, effectScope, type MaybeRefOrGetter, toValue } from "vue";
import { invalidatePushedQueries } from "../../lib/pushInvalidation";
import { SANDBOX_MEMBERS, SANDBOX_SELF_ACCESS } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";
import { sandboxRaw } from "./sandboxRaw";
import { useSandbox } from "./useSandbox";
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

// WHETHER THE SIGNED-IN PERSON RUNS AGENTS, for the one tier whose name does not say: a writer edits files by hand and
// may or may not drive agents (sandbox-contract `memberAccess`). Every other tier answers it by itself, so the read is
// made for a writer alone. One query for the whole app, made once in its own scope, since `useRole` is read from plain
// functions as well as components and a per-call query would need a component to belong to.

let agents: ComputedRef<AgentAccess | undefined> | undefined;

export const selfAgents = (): ComputedRef<AgentAccess | undefined> => {
    if (agents === undefined) {
        // Detached: it lives as long as the app, like the sandbox list it reads.
        agents = effectScope(true).run(() => {
            const { active } = useSandbox();
            const { query } = useSandboxQuery<MemberSelf>({
                queryKey: SANDBOX_SELF_ACCESS.of(),
                queryFn: () => sandboxRaw(`GET /members/self`),
                enabled: computed(() => active.value?.role === `writer`),
            });
            return computed(() => query.data.value?.agents);
        });
    }
    // SAFETY: `run` on a scope that is active answers what its callback returned, which is always a computed here.
    return agents as ComputedRef<AgentAccess | undefined>;
};
