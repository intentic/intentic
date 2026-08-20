import { type PublicList, PublicListSchema } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, type MaybeRefOrGetter, toValue } from "vue";
import { PUBLIC } from "../queryKeys";
import { sandboxJson } from "../sandbox/sandboxClient";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";

/* THE WORKSPACE OUTBOX, read from the app rather than from the preview extension — the Preview area lists the
 * served page as its "Public site" target, so the app needs its own read of what is actually published.
 *
 * IT REGISTERS UNDER THE EXTENSION'S OWN KEY (see PUBLIC in queryKeys). The preview extension's manifest binds
 * `public/` to the name `public`, so the daemon's file watcher already pushes staleness for this exact key on
 * every write into the directory — this read inherits that for free, and the two surfaces can never disagree
 * about what is published.
 *
 * `live` IS A CLOCK, AND IT IS THE ONE EXCEPTION. That push is unioned from the ACTIVATED extensions, so on a
 * sandbox where the preview extension never activated there may be nothing carrying it. Rather than teach the
 * core table about one extension's directory, a caller that cannot rely on the push asks for a tick, and only
 * while it is genuinely waiting for a file to appear. Everything else here is push-driven and holds no clock. */

// While a build is in flight. Fast enough that the page appears to land the moment it is written, and running
// only inside the seconds the screen is actually watching for it.
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
        /* The outbox's own address. Absent on a sandbox with no tunnel, which is the honest signal that nothing
         * here can be published at all — a screen promising a public link on such a box would be lying. */
        url: computed(() => query.data.value?.url),
        settled: computed(() => query.isFetched.value || query.isError.value),
        error,
        invalidate: async (): Promise<void> => {
            await queryClient.invalidateQueries({ queryKey });
        },
    };
}
