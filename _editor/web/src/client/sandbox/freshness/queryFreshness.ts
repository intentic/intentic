import { sandboxRef } from "@intentic/extension-api";
import { reportFreshness } from "@intentic/ui";
import { computed, readonly, type Ref, ref, watch } from "vue";
import { useSandbox } from "../useSandbox";

// A vue-query read's freshness, reported to the pane it is read in (@intentic/ui's FreshnessFrame): how old its answer on
// screen is, and since when a newer one has been on its way. Every daemon read (useSandboxQuery) and every extension's
// own vue-query read (the host's shim, hostModules.ts) passes through here, so a pane speaks for all of them, bundles
// built before it included.

interface QueryFacts {
    readonly data: Ref<unknown>;
    readonly isFetching: Ref<boolean>;
    readonly dataUpdatedAt: Ref<number>;
}

export const reportQueryFreshness = (query: QueryFacts, refreshError: () => string | undefined): void => {
    const since = ref<number | undefined>(undefined);
    const joined = reportFreshness(() => ({
        shown: query.data.value !== undefined,
        // vue-query's zero is "never received", not the epoch.
        updatedAt: query.dataUpdatedAt.value === 0 ? undefined : query.dataUpdatedAt.value,
        refreshingSince: since.value,
        refreshError: query.data.value === undefined ? undefined : refreshError(),
    }));
    // Outside a pane nothing listens, and a read made from a plain handler has no scope to stop a watcher with.
    if (!joined) {
        return;
    }
    watch(
        query.isFetching,
        (fetching) => {
            since.value = fetching ? (since.value ?? Date.now()) : undefined;
        },
        // Every change, not the last one per tick: a try that starts and ends between two ticks must still end here.
        { flush: `sync`, immediate: true },
    );
};

// What a pane's frame needs of the sandbox itself: whether it is answering at all, and when it last stopped. Until that
// moment the live stream kept every cached answer true, so an answer fetched an hour before a drop is as of the drop.
// One record for every pane, kept per sandbox: watched here rather than in a pane, whose unmount would stop it, and
// scoped to the sandbox so the next one picked does not inherit this one's drop.
const { reachable } = useSandbox();
const lostAt = sandboxRef<number | undefined>(() => undefined);
watch(reachable, (answering, was) => {
    if (!answering && was) {
        lostAt.value = Date.now();
    }
});
const offline = computed(() => !reachable.value);

export const useSandboxLiveness = () => ({ offline, lostAt: readonly(lostAt) });
