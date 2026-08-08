import type { SandboxSummary } from "@intentic-app/api-contract";
import { hashKey } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { removeStoredValue, storedValue, storeValue } from "../browserStorage";
import { queryClient } from "../queryPersistence";
import { apiClient } from "../useApi";
import { withConcurrency } from "../concurrency";
import { applyConnectionSignal, type ConnectionSignal, type ConnectionState, initialConnection } from "./connection";
import { daemonReady } from "./useDaemonBoot";

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
const activeSandboxId = ref<string | undefined>(storedValue(ACTIVE_KEY));

// The ACTIVE daemon's connection, as one state machine value (see connection.ts) rather than a set of
// booleans. Browser-owned: the platform's registry knows a sandbox exists and when it last announced itself,
// but only this browser can answer "can *I* reach it right now", and only the stream can say why not.
// Starts idle: the shell shows the connecting gate until the daemon actually answers, so a not-yet-ready
// sandbox never renders a dead UI and a switch never shows the old sandbox as online.
const connection = ref<ConnectionState>(initialConnection);

// The single writer. Every transition goes through the pure reducer, so the sequencing rules (a heartbeat is
// idempotent, a switch clears the outgoing cause, backoff resets on a healthy stream) live in one tested place
// instead of being re-implemented at each assignment site.
export const signalConnection = (signal: ConnectionSignal): void => {
    connection.value = applyConnectionSignal(connection.value, signal);
};

/* Can this browser READ the active daemon right now — the gate on every daemon-backed query and on the rail's
 * inert-while-offline affordances. The one projection most callers want, and two facts rather than one.
 *
 * A live stream is not enough. The daemon brings its listeners up before the state they serve has converged
 * (its main.ts: listen first, converge behind the gate), so for the first seconds of a boot it answers /events
 * and parks everything else. Reading `online` as "go" meant every query fired into that gate at once — the
 * pending storm that made a fresh `dev-sandbox.sh` swap look hung, and made a workspace hydrated from the
 * persisted cache look operable while nothing it offered could work. So the daemon's own readiness (received
 * on the hello + boot frames — useDaemonBoot) is the second half, and the wait becomes a visible warm-up
 * instead of a workspace that silently does nothing. */
const reachable = computed(() => connection.value.phase === `online` && daemonReady.value);

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
        removeStoredValue(ACTIVE_KEY);
        return;
    }
    storeValue(ACTIVE_KEY, id);
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
// restarted daemon's new daemonUrl. Single-flighted because those callers overlap by design (a reconnect
// storm during onboarding is three of them at once) and `staleTime: 0` is precisely the instruction NOT to
// let the cache dedupe them — so without a policy each one is its own platform round-trip.
const refresh = withConcurrency<void, SandboxSummary[]>(
    async (): Promise<SandboxSummary[]> => reconcileActive(await queryClient.fetchQuery({ ...sandboxListQuery, staleTime: 0 })),
    { mode: `singleFlight`, key: () => `sandbox.list` },
);

// Point the workspace at a different sandbox (persisted). Liveness re-probes the new daemon on the next tick,
// sandboxScope re-scopes the client-side state, and sandboxScreen lands on the screen this window last had
// open there.
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

// Rename a sandbox and/or set its switcher logo — `image: null` clears it (owner-only; the API enforces).
// Writing the returned row into the list cache is what repaints the rail chip in the same tick as the hub's
// own tile.
//
// The sandbox is NAMED by the caller rather than taken from the active selection, because the two are not the
// same sandbox everywhere: /setup renames the row it just created while `reconcileActive` can still be moving
// the selection off it (a just-created row is briefly absent from a server list read), and renaming whichever
// sandbox happens to be selected would quietly rename a different one of the user's machines. The updated row
// is handed back for the same reason — /setup holds its own reference to it, and everything the install command
// derives from the name (the sync folder) would otherwise go on describing the old one.
const update = async (sandboxId: string, input: { name?: string; image?: string | null }): Promise<SandboxSummary> => {
    const updated = await apiClient.sandbox.update({ sandboxId, ...input });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
        live.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
    );
    return updated;
};

// Point a sandbox at a URL the owner runs it behind (setup's "I already have one running" path) and make it
// active. The platform stamps lastSeenAt like an announce, so the returned row is immediately "connected".
const attach = async (id: string, url: string): Promise<void> => {
    const updated = await apiClient.sandbox.attach({ sandboxId: id, daemonUrl: url });
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
        live.map((sandbox) => (sandbox.id === updated.id ? updated : sandbox)),
    );
    persistActive(updated.id);
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
    return { sandboxes, activeSandboxId, active, daemonUrl, connection, reachable, list, refresh, select, create, update, attach, remove };
}
