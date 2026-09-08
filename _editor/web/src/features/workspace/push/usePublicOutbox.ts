import { type PublicList, PublicListSchema } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { PUBLIC } from "../../../lib/queryKeys";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";

// Reads the workspace outbox from the app, since Preview's own target needs its own read. Registered under the
// preview extension's query key (PUBLIC), so its staleness push covers this read too. `live` is the one
// exception: a caller that can't rely on the push asks for a tick, only while waiting for a file to appear.

// While a build is in flight; fast enough the page seems to land the moment it's written, only while watched.
const WATCH_MS = 1500;

export function usePublicOutbox(live: MaybeRefOrGetter<boolean> = false) {
    const queryClient = useQueryClient();
    const queryKey = PUBLIC.of();

    const { query, error } = useSandboxQuery<PublicList>({
        queryKey,
        queryFn: async () => PublicListSchema.parse(await sandboxJson(`/public`)),
        refetchInterval: computed(() => (toValue(live) ? WATCH_MS : false)),
    });

    return {
        files: computed(() => query.data.value?.files ?? []),
        // The outbox's address; absent on a sandbox with no tunnel, the honest signal that nothing here can publish.
        url: computed(() => query.data.value?.url),
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        invalidate: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey });
        },
    };
}
