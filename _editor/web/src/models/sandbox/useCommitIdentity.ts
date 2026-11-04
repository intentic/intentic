import { sandboxScopeGuard } from "@intentic/extension-api";
import type { CommitIdentityState, GitPerson } from "@intentic/sandbox-contract/schemas/settings";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { useMutation } from "@tanstack/vue-query";
import { computed } from "vue";
import { rpcQuery } from "../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../client/sandbox/useDaemonRoutes";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../lib/queryKeys";
import { queryClient } from "../../lib/queryPersistence";

// The reader's own commit name and address on the active sandbox (`settings.commitIdentity`), and the write that sets or
// forgets it. Each person's own, like the audience, so it has its own route and cache entry rather than a field in
// useSandboxSettings, and nobody else's is read or written here. Whether commits use it at all is the sandbox's
// `commitAttribution`, read from the settings; the copy this answer carries is only what the daemon said beside it.

const QUERY_KEY = rpcKey(`settings.commitIdentity`);

// A daemon older than these routes keeps no commit identity, so it is never asked and the fields are not offered.
const daemonKeeps = (): boolean => supportsRoute(`settings.commitIdentity`) && supportsRoute(`settings.setCommitIdentity`);

export function useCommitIdentity() {
    const supported = computed(daemonKeeps);
    const { query, error } = useSandboxQuery({ ...rpcQuery(`settings.commitIdentity`), enabled: supported });

    const save = useMutation(
        {
            // The answer is the whole state as kept, so it replaces the cached read instead of asking again. Not after a
            // switch: the key names whichever sandbox is active, and the next one's read is not this answer.
            mutationFn: async (identity: GitPerson | null): Promise<CommitIdentityState> => {
                const current = sandboxScopeGuard();
                const state = await sandboxRpc.settings.setCommitIdentity({ identity });
                if (current()) {
                    queryClient.setQueryData(QUERY_KEY, state);
                }
                return state;
            },
        },
        // Named rather than injected, as useSandboxSettings does: a write can start from a plain handler.
        queryClient,
    );

    // The last write as the daemon refused it, in its own words, gone once the next one starts: the fields still hold what
    // was typed, so without this a press that changed nothing reads as one that worked. Else a read that failed, which
    // would otherwise leave the fields disabled with no reason given.
    const refusal = computed<NoticeModel | undefined>(() => {
        if (save.error.value !== null) {
            return noticeFrom(save.error.value, t(`sandbox.agentCommitAuthor.couldntSave`));
        }
        return error.value === undefined ? undefined : { tone: `danger`, title: t(`sandbox.agentCommitAuthor.couldntRead`), detail: error.value };
    });

    return {
        supported,
        state: computed<CommitIdentityState | undefined>(() => query.data.value),
        setIdentity: (identity: GitPerson | null): void => save.mutate(identity),
        saving: save.isPending,
        refusal,
    };
}
