import type { SandboxSummary } from "@intentic-app/api-contract";
import { hashKey } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { queryClient } from "./queryPersistence";
import { apiClient } from "./useApi";

/* The browser's view of the user's sandboxes, as a module-level singleton. A user can own several sandboxes and
 * be a member of others; the platform is the registry — each daemon announces its own URL + lastSeenAt, and the
 * browser only reads them (sandbox.list). `reachable` stays browser-owned (useSandboxLiveness's direct SSE probe
 * of the ACTIVE sandbox): it answers "can THIS browser reach it", which the registry can't know. */

// The key under which the active sandbox id is persisted, so a reload keeps the same one selected.
const ACTIVE_KEY = `intentic.activeSandboxId`;

// The account-scoped key for the sandbox list in the shared query cache. Static (unlike sandboxKey, which
// APPENDS the active id for per-sandbox daemon queries) — this list is the registry of ALL sandboxes, and its
// distinct `sandbox` prefix is what queryPersistence excludes from disk (the rows carry connect tokens).
const SANDBOX_LIST_KEY = [`sandbox`, `list`];

// Ids with an in-flight remove(): a fetch that reads the server DURING the slow owner-delete teardown gets
// pre-delete truth back, so the shared queryFn filters them until the removal settles — else the just-removed
// row reappears (e.g. /setup's atLimit upsell for a sandbox being deleted). cancelQueries handles the local
// write-ordering race; this Set handles the server-consistency window it can't.
const removing = new Set<string>();

const sandboxListQuery = {
    queryKey: SANDBOX_LIST_KEY,
    queryFn: async (): Promise<SandboxSummary[]> => (await apiClient.sandbox.list()).sandboxes.filter((sandbox) => !removing.has(sandbox.id)),
    // The list only changes via local mutations (which write the cache directly) or a daemon's lastSeenAt/
    // daemonUrl update (onboarding only, where refresh() forces fresh) — 30s dedups the shell's per-navigation
    // refetch with no staleness that matters.
    staleTime: 30_000,
    // Observer-less entry (fetchQuery-only, mirrored via the cache subscription below): the default gcTime
    // would evict it after 5 idle minutes, wiping daemonUrl mid-session and failing every daemon call with
    // "isn't reachable yet". Pinned; logout still drops it via queryClient.clear().
    gcTime: Infinity,
};

// Every sandbox the user can reach (owned first, then shared). Fed ONLY by the query cache so the router guard,
// liveness loop, and sandboxClient keep reading it synchronously (a plain getQueryData() has no Vue reactivity,
// and useQuery can't run in those contexts). A QueryCache subscription — NOT a QueryObserver, which detaches on
// queryClient.clear() at logout — mirrors the entry: it fires on fetchQuery success and on setQueryData
// synchronously (the switcher's post-remove .length read is correct this tick), and resets to [] when the
// cache is cleared. Scoped to our key by hash; other queries' events are a cheap string compare.
const SANDBOX_LIST_HASH = hashKey(SANDBOX_LIST_KEY);
const sandboxes = ref<SandboxSummary[]>([]);
queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === SANDBOX_LIST_HASH) {
        sandboxes.value = queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY) ?? [];
    }
});
// Which sandbox the workspace is pointed at right now.
const activeSandboxId = ref<string | undefined>(localStorage.getItem(ACTIVE_KEY) ?? undefined);
// Whether the active daemon is reachable — set by the shell's live SSE probe loop, never by the platform.
// Starts pessimistic: the shell shows the "connecting" gate until the ACTIVE daemon actually answers, so a
// not-yet-ready sandbox never renders a dead UI, and a switch never shows the old sandbox as online.
const reachable = ref(false);
// True when the daemon answered the liveness probe with 403: the signed-in Google account is neither the
// owner nor a member. Sticky across network errors (a denied sandbox going offline stays "denied", which
// self-corrects on the next resolved probe). Owned by useSandboxLiveness, like `reachable`.
const denied = ref(false);
// Why the last liveness attempt failed (undefined while healthy) — the connecting gate shows it so a stuck
// connection names its cause (401, network, …) instead of spinning silently. Owned by useSandboxLiveness.
const probeError = ref<string | undefined>();

const active = computed(() => sandboxes.value.find((sandbox) => sandbox.id === activeSandboxId.value));
// The active sandbox's public URL — what the sandbox client + liveness talk to. Undefined until one is bound.
const daemonUrl = computed(() => active.value?.daemonUrl ?? undefined);

// Append the active sandbox id to a vue-query key so each sandbox's cached server state is independent
// (switching never serves another sandbox's data). Appended, not prepended, so existing prefix-based
// invalidateQueries(['workspace','tree']) still match. vue-query deep-unrefs the id ref, so the query
// refetches under a fresh key the moment the active sandbox changes.
export const sandboxKey = (...parts: readonly unknown[]): unknown[] => [...parts, activeSandboxId];

const persistActive = (id: string | undefined): void => {
    activeSandboxId.value = id;
    if (id === undefined) {
        localStorage.removeItem(ACTIVE_KEY);
        return;
    }
    localStorage.setItem(ACTIVE_KEY, id);
};

// Keep the active selection if it still exists, else fall back to the first sandbox. Shared by list/refresh.
const reconcileActive = (live: SandboxSummary[]): SandboxSummary[] => {
    if (activeSandboxId.value === undefined || !live.some((sandbox) => sandbox.id === activeSandboxId.value)) {
        persistActive(live[0]?.id);
    }
    return live;
};

// Load the user's sandboxes through the shared cache: concurrent callers (requireSetup + the liveness loop +
// the switcher) coalesce to ONE request, and a call within staleTime serves cache with no round-trip.
const list = async (): Promise<SandboxSummary[]> => reconcileActive(await queryClient.fetchQuery(sandboxListQuery));

// Force a fresh list regardless of staleTime — for callers that must observe just-changed server state:
// onboarding polling (Setup), a just-accepted invite (AcceptInvite), and liveness recovery picking up a
// restarted daemon's new daemonUrl.
const refresh = async (): Promise<SandboxSummary[]> => reconcileActive(await queryClient.fetchQuery({ ...sandboxListQuery, staleTime: 0 }));

// Point the workspace at a different sandbox (persisted). Liveness re-probes the new daemon on the next tick.
const select = (id: string): void => {
    persistActive(id);
};

// Mint a new sandbox and make it active — the entry point of the "add sandbox" flow.
const create = async (name: string): Promise<SandboxSummary> => {
    const sandbox = await apiClient.sandbox.create({ name });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) => [...live, sandbox]);
    persistActive(sandbox.id);
    return sandbox;
};

// Rename the active sandbox and/or set its switcher logo (owner-only; the API enforces). No-op when nothing is active.
const update = async (input: { name?: string; image?: string }): Promise<void> => {
    if (activeSandboxId.value === undefined) {
        return;
    }
    const updated = await apiClient.sandbox.update({ sandboxId: activeSandboxId.value, ...input });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
        live.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
    );
};

// Remove a sandbox from this account: owners drop the platform row + its intentic-provided tunnel (member
// grants cascade), members drop their own grant. The local containers keep running — cleanup.sh's job.
const remove = async (id: string): Promise<void> => {
    const previous = queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY);
    const target = previous?.find((sandbox) => sandbox.id === id);
    if (target === undefined) {
        return;
    }
    // Drop the row optimistically BEFORE the first await, so the switcher's synchronous empty-check sees it
    // gone this tick; `removing` keeps any mid-teardown fetch from resurrecting it (see the queryFn filter).
    removing.add(id);
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) => live.filter((sandbox) => sandbox.id !== id));
    if (activeSandboxId.value === id) {
        persistActive(queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY)?.[0]?.id);
    }
    // Cancel any in-flight list() so its pre-delete result can't clobber the optimistic drop (replaces the old
    // generation guard; the setQueryData above already moved the cancel-revert snapshot to the dropped row).
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    try {
        await (target.role === `owner` ? apiClient.sandbox.delete({ sandboxId: id }) : apiClient.sandbox.leave({ sandboxId: id }));
    } catch (error) {
        removing.delete(id); // clear first so the rollback can bring the row back
        queryClient.setQueryData(SANDBOX_LIST_KEY, previous); // failed removal: restore the pre-drop rows
        throw error;
    }
    removing.delete(id);
};

export function useSandbox() {
    return { sandboxes, activeSandboxId, active, daemonUrl, reachable, denied, probeError, list, refresh, select, create, update, remove };
}
