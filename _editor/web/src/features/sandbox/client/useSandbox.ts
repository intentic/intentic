import type { SandboxSummary } from "@intentic/api-contract";
import { ORPCError } from "@orpc/client";
import { hashKey } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { removeStoredValue, storeValue } from "../../../lib/browserStorage";
import { ACTIVE_KEY, activeSandboxId } from "../overview/activeSandbox";
import { queryClient } from "../../../lib/queryPersistence";
import { apiClient } from "../../../lib/useApi";
import { withConcurrency } from "../../../lib/concurrency";
import { applyConnectionSignal, type ConnectionSignal, type ConnectionState, initialConnection } from "../live/connection";
import { daemonReady } from "../overview/useDaemonBoot";

// Browser's view of the user's sandboxes, as a module singleton. The registry (sandbox.list) is the source of
// truth for each daemon's URL/lastSeenAt; `reachable` stays browser-owned since only this browser knows if it
// can reach the active one.

// Static key for the full list, excluded from disk by queryPersistence (rows carry connect tokens).
const SANDBOX_LIST_KEY = [`sandbox`, `list`];

// Ids with an in-flight remove(); the queryFn filters them out since a fetch mid-teardown reads pre-delete truth.
const removing = new Set<string>();

const sandboxListQuery = {
    queryKey: SANDBOX_LIST_KEY,
    queryFn: async (): Promise<SandboxSummary[]> => (await apiClient.sandbox.list()).sandboxes.filter((sandbox) => !removing.has(sandbox.id)),
    // 30s dedups the shell's per-navigation refetch; the list only changes via local writes or a daemon announce.
    staleTime: 30_000,
    // Pinned: the default gcTime would evict this observer-less entry after idle minutes and wipe daemonUrl
    // mid-session.
    gcTime: Infinity,
};

// A QueryCache subscription, not a QueryObserver (which detaches on queryClient.clear() at logout): mirrors the
// entry into a ref so callers outside a component setup can read it synchronously.
const SANDBOX_LIST_HASH = hashKey(SANDBOX_LIST_KEY);
const sandboxes = ref<SandboxSummary[]>([]);
queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === SANDBOX_LIST_HASH) {
        sandboxes.value = queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY) ?? [];
    }
});

// Browser-owned connection state machine (see connection.ts); starts idle so a not-yet-ready sandbox never
// renders as live.
const connection = ref<ConnectionState>(initialConnection);

// Single writer: every transition goes through the pure reducer so the sequencing rules live in one place.
export const signalConnection = (signal: ConnectionSignal): void => {
    connection.value = applyConnectionSignal(connection.value, signal);
};

// True only once the stream is live and the daemon reports ready; liveness alone precedes convergence.
const reachable = computed(() => connection.value.phase === `online` && daemonReady.value);

const active = computed(() => sandboxes.value.find((sandbox) => sandbox.id === activeSandboxId.value));
// The active sandbox's public URL; undefined until one is bound.
const daemonUrl = computed(() => active.value?.daemonUrl ?? undefined);

const persistActive = (id: string | undefined): void => {
    activeSandboxId.value = id;
    if (id === undefined) {
        removeStoredValue(ACTIVE_KEY);
        return;
    }
    storeValue(ACTIVE_KEY, id);
};

// Keeps the active selection if it still exists, else falls back to the first sandbox. Shared by list/refresh.
const reconcileActive = (live: SandboxSummary[]): SandboxSummary[] => {
    if (activeSandboxId.value === undefined || !live.some((sandbox) => sandbox.id === activeSandboxId.value)) {
        persistActive(live[0]?.id);
    }
    return live;
};

// Loads sandboxes through the shared cache: concurrent callers coalesce to one request, and a call within
// staleTime serves from cache.
const list = async (): Promise<SandboxSummary[]> => reconcileActive(await queryClient.fetchQuery(sandboxListQuery));

// Forces a fresh list past staleTime, single-flighted so overlapping callers (onboarding, invite accept,
// liveness recovery) share one round-trip.
const refresh = withConcurrency<void, SandboxSummary[]>(
    async (): Promise<SandboxSummary[]> => reconcileActive(await queryClient.fetchQuery({ ...sandboxListQuery, staleTime: 0 })),
    { mode: `singleFlight`, key: () => `sandbox.list` },
);

// Points the workspace at a different sandbox (persisted); liveness re-probes it, and sandboxScope/sandboxScreen
// follow the new active id.
const select = (id: string): void => {
    persistActive(id);
};

// Mints a new sandbox; does not make it active. /setup creates the row before the reader has agreed to
// anything, so selection moves only on announce or a successful attach.
const create = async (name: string): Promise<SandboxSummary> => {
    const sandbox = await apiClient.sandbox.create({ name });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) => [...live, sandbox]);
    return sandbox;
};

// A provision response cannot overwrite a cancellation that started after it.
const hostedChanges = new Map<string, number>();

const hostedProvision = async (sandboxId: string, token: string): Promise<SandboxSummary> => {
    const version = hostedChanges.get(sandboxId);
    const updated = await apiClient.sandbox.hostedProvision({ sandboxId, token });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    if (hostedChanges.get(sandboxId) === version) {
        queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
            live.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
        );
    }
    return updated;
};

const hostedRelease = withConcurrency(
    async (sandboxId: string): Promise<SandboxSummary> => {
        hostedChanges.set(sandboxId, (hostedChanges.get(sandboxId) ?? 0) + 1);
        const updated = await apiClient.sandbox.hostedRelease({ sandboxId });
        await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
        queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
            live.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
        );
        return updated;
    },
    { mode: `singleFlight`, key: (sandboxId) => sandboxId },
);

// Wakes a sleeping hosted sandbox on a network-shaped connection failure, from any path that lands on it.
// PAYMENT_REQUIRED (spent hours) is the one refusal kept and shown rather than swallowed.
const WAKE_THROTTLE_MS = 60_000;
const wokeAt = new Map<string, number>();
// The sandbox whose last wake the platform refused for spent hours, with its own message.
const wakeRefused = ref<{ readonly sandboxId: string; readonly message: string } | undefined>(undefined);
const recordWake = (sandboxId: string, outcome: unknown): void => {
    if (outcome instanceof ORPCError && outcome.code === `PAYMENT_REQUIRED`) {
        wakeRefused.value = { sandboxId, message: outcome.message };
        return;
    }
    if (wakeRefused.value?.sandboxId === sandboxId && outcome === undefined) {
        wakeRefused.value = undefined;
    }
};
watch(
    () => [active.value?.id, active.value?.hosted !== null && active.value?.hosted !== undefined, connection.value] as const,
    ([id, hosted, state]) => {
        if (id === undefined || !hosted || state.failure === undefined) {
            return;
        }
        // Network-shaped causes only; a 403 or a missing address is not a sleeping machine.
        if (state.failure.kind !== `network` && state.failure.kind !== `timeout` && state.failure.kind !== `closed`) {
            return;
        }
        const last = wokeAt.get(id) ?? 0;
        if (Date.now() - last < WAKE_THROTTLE_MS) {
            return;
        }
        wokeAt.set(id, Date.now());
        void apiClient.sandbox
            .wake({ sandboxId: id })
            .then(() => recordWake(id, undefined))
            .catch((error: unknown) => recordWake(id, error));
    },
);
// Whether the ACTIVE sandbox's last wake was refused for spent hours.
const activeWakeRefused = computed(() =>
    wakeRefused.value !== undefined && wakeRefused.value.sandboxId === active.value?.id ? wakeRefused.value : undefined,
);

// Renames and/or re-logos a sandbox (owner-only; `image: null` clears it). Named explicitly rather than taken
// from the active selection, since the two can differ mid-reconcile.
const update = async (sandboxId: string, input: { name?: string; image?: string | null }): Promise<SandboxSummary> => {
    const updated = await apiClient.sandbox.update({ sandboxId, ...input });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
        live.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
    );
    return updated;
};

// Points a sandbox at a URL it runs behind and makes it active; the platform stamps lastSeenAt like an announce.
const attach = async (id: string, url: string): Promise<void> => {
    const updated = await apiClient.sandbox.attach({ sandboxId: id, daemonUrl: url });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
        live.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
    );
    persistActive(updated.id);
};

// Removes a sandbox from this account: owners drop the row and its tunnel, members drop their grant. Local
// containers keep running.
const remove = async (id: string): Promise<void> => {
    const previous = queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY);
    const target = previous?.find((sandbox) => sandbox.id === id);
    if (target === undefined) {
        return;
    }
    // Drops the row optimistically before the first await, so the switcher's synchronous check sees it gone this tick.
    removing.add(id);
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) => live.filter((sandbox) => sandbox.id !== id));
    if (activeSandboxId.value === id) {
        persistActive(queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY)?.[0]?.id);
    }
    // Cancels any in-flight list() so its pre-delete result can't clobber the optimistic drop.
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    try {
        await (target.role === `owner` ? apiClient.sandbox.delete({ sandboxId: id }) : apiClient.sandbox.leave({ sandboxId: id }));
    } catch (error) {
        removing.delete(id); // clear first so the rollback below can restore the row
        queryClient.setQueryData(SANDBOX_LIST_KEY, previous); // failed removal: restore the pre-drop rows
        throw error;
    }
    removing.delete(id);
};

export function useSandbox() {
    return {
        sandboxes,
        activeSandboxId,
        active,
        daemonUrl,
        connection,
        reachable,
        activeWakeRefused,
        list,
        refresh,
        select,
        create,
        hostedProvision,
        hostedRelease,
        update,
        attach,
        remove,
    };
}
