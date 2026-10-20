import { track } from "../../app/analytics";
import { noteUnreachable } from "./reachability";
import type { SandboxSummary } from "@intentic/api-contract";
import { ORPCError } from "@orpc/client";
import { hashKey } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { arrivingProfile } from "../../app/useProfile";
import { DESKTOP_SANDBOX_WAKES_LINK, desktopApp, openDesktopLink } from "../../app/environments/desktop";
import { removeStoredValue, storeValue } from "../../app/storage/browserStorage";
import { ACTIVE_KEY, activeSandboxId } from "../../app/storage/activeSandbox";
import { queryClient } from "../../lib/queryPersistence";
import { optimisticUpdate } from "../../lib/optimistic";
import { apiClient } from "../../lib/useApi";
import { withConcurrency } from "../../lib/concurrency";
import { applyConnectionSignal, type ConnectionSignal, type ConnectionState, initialConnection } from "./connection";
import { daemonReady } from "./useDaemonBoot";
import { closeAllWakeWindows, closeWakeWindow, openWakeWindow } from "./wake/wakeWindow";
import { forgetAddress } from "../directory/deviceDirectory";
import { directMode } from "../directory/directState";
import type { LeaveOutcome } from "./leaveSandbox";
import { markBoot } from "../../app/perf/boot";

// Browser's view of the user's sandboxes, as a module singleton. The registry (sandbox.list) is the source of
// truth for each daemon's URL/lastSeenAt; `reachable` stays browser-owned since only this browser knows if it
// can reach the active one.

// Static key for the full list, excluded from disk by queryPersistence (rows carry connect tokens).
export const SANDBOX_LIST_KEY = [`sandbox`, `list`];

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
// allow(module-state): the account's sandbox list, which a switch chooses from
const sandboxes = ref<SandboxSummary[]>([]);
queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === SANDBOX_LIST_HASH) {
        sandboxes.value = queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY) ?? [];
    }
});

// Browser-owned connection state machine (see connection.ts); starts idle so a not-yet-ready sandbox never
// renders as live.
// allow(module-state): the connection machine, which crosses a switch through its own `switched` signal
const connection = ref<ConnectionState>(initialConnection);

// Single writer: every transition goes through the pure reducer so the sequencing rules live in one place.
export const signalConnection = (signal: ConnectionSignal): void => {
    connection.value = applyConnectionSignal(connection.value, signal);
    // A waking window (wake/wakeWindow.ts) ends with the wait it speeds up: a frame is the sandbox back, and a disconnect is
    // the loop that was dialling it torn down.
    if (signal.kind === `frame` && activeSandboxId.value !== undefined) {
        closeWakeWindow(activeSandboxId.value);
    } else if (signal.kind === `disconnect`) {
        closeAllWakeWindows();
    }
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
// staleTime serves from cache. Opened directly (recovery/directMode.ts), the list is the one this device remembers and
// the platform is not asked: it is down, and a navigation a minute in must not send the reader back to say so.
const list = async (): Promise<SandboxSummary[]> => {
    const rows = directMode.value ? sandboxes.value : await queryClient.fetchQuery(sandboxListQuery);
    // The sandbox list the shell's gate waits on, as the start's timeline counts it (app/perf/boot.ts; the first only).
    markBoot(`list`);
    return reconcileActive(rows);
};

// Forces a fresh list past staleTime, single-flighted so overlapping callers (onboarding, invite accept,
// liveness recovery) share one round-trip.
const refresh = withConcurrency<void, SandboxSummary[]>(
    async (): Promise<SandboxSummary[]> =>
        reconcileActive(directMode.value ? sandboxes.value : await queryClient.fetchQuery({ ...sandboxListQuery, staleTime: 0 })),
    { mode: `singleFlight`, key: () => `sandbox.list` },
);

// Points the workspace at a different sandbox (persisted); liveness re-probes it, and sandboxScope/sandboxScreen
// follow the new active id.
const select = (id: string): void => {
    persistActive(id);
    const box = sandboxes.value.find((row) => row.id === id);
    if (box?.hosted?.state === `asleep`) {
        // allow(silent-catch): wake() already recorded the refusal for the gate and sent sandbox_wake with its outcome
        void wake(id, `switch`).catch(() => undefined);
    }
};

// A write's answer, put on the cached list: the row it returned replaces its old self, or joins the list when the write
// `added` it. A list read already in flight is cancelled first, or its older answer would land after this one and put
// the row back as it was. `current` lets a write that may have been overtaken (a provision a release came after) leave
// the list to the later one.
const landOnList = async (row: SandboxSummary, { added = false, current = (): boolean => true } = {}): Promise<void> => {
    await queryClient.cancelQueries({ queryKey: SANDBOX_LIST_KEY });
    if (!current()) {
        return;
    }
    queryClient.setQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY, (live = []) =>
        added ? [...live, row] : live.map((sandbox) => (sandbox.id === row.id ? row : sandbox)),
    );
};

// Mints a new sandbox; does not make it active. /setup creates the row before the reader has agreed to
// anything, so selection moves only on announce or a successful attach.
const create = async (name: string): Promise<SandboxSummary> => {
    const sandbox = await apiClient.sandbox.create({ name });
    await landOnList(sandbox, { added: true });
    return sandbox;
};

// A provision response cannot overwrite a cancellation that started after it.
const hostedChanges = new Map<string, number>();

const hostedProvision = async (sandboxId: string, token: string): Promise<SandboxSummary> => {
    const version = hostedChanges.get(sandboxId);
    // The machine composes its environment from this: the profile's own sandbox.toml is applied at its first boot.
    const updated = await apiClient.sandbox.hostedProvision({ sandboxId, token, profile: arrivingProfile() });
    await landOnList(updated, { current: () => hostedChanges.get(sandboxId) === version });
    return updated;
};

const hostedRelease = withConcurrency(
    async (sandboxId: string): Promise<SandboxSummary> => {
        hostedChanges.set(sandboxId, (hostedChanges.get(sandboxId) ?? 0) + 1);
        const updated = await apiClient.sandbox.hostedRelease({ sandboxId });
        await landOnList(updated);
        return updated;
    },
    { mode: `singleFlight`, key: (sandboxId) => sandboxId },
);

// Wakes a sleeping sandbox on a network-shaped connection failure, from any path that lands on it. A hosted one is
// started by the platform; one on its owner's own machine is asked for, and that machine's keeper starts it when it
// next asks (2026-10-10: a keeper puts an unused local sandbox to sleep). Two refusals are kept and shown rather than
// swallowed: PAYMENT_REQUIRED (spent hours) and FORBIDDEN (the owner's hosted lane is switched off); everything else is
// a wait.
const WAKE_THROTTLE_MS = 60_000;
const wokeAt = new Map<string, number>();
export type WakeRefusalKind = "hours" | "suspended";
// The sandbox whose last wake the platform refused, why, and in the platform's own words.
// allow(module-state): a refused wake, stamped with the sandbox it names
const wakeRefused = ref<{ readonly sandboxId: string; readonly kind: WakeRefusalKind; readonly message: string } | undefined>(undefined);
const refusalKind = (outcome: unknown): WakeRefusalKind | undefined => {
    if (!(outcome instanceof ORPCError)) {
        return undefined;
    }
    return outcome.code === `PAYMENT_REQUIRED` ? `hours` : outcome.code === `FORBIDDEN` ? `suspended` : undefined;
};
const recordWake = (sandboxId: string, outcome: unknown): void => {
    const kind = refusalKind(outcome);
    if (kind !== undefined && outcome instanceof ORPCError) {
        wakeRefused.value = { sandboxId, kind, message: outcome.message };
        return;
    }
    if (wakeRefused.value?.sandboxId === sandboxId && outcome === undefined) {
        wakeRefused.value = undefined;
    }
};
// In the desktop app, a wake the platform took for a sandbox on its owner's own computer is collected on this computer at
// once, in case that is where it sleeps (sandbox_wakes.rs in the app): the keeper there would collect it on its next
// poll, up to fifteen seconds of the wait. A sandbox asleep on another computer costs the app one look at its own.
const collectWakeHere = (box: SandboxSummary | undefined): void => {
    if (box !== undefined && box.hosted === null && desktopApp()?.sandboxWakes === true) {
        openDesktopLink(DESKTOP_SANDBOX_WAKES_LINK);
    }
};
watch(
    () => [active.value?.id, connection.value] as const,
    ([id, state]) => {
        if (id === undefined || state.failure === undefined) {
            return;
        }
        // A sleeping machine's causes: silence, or the edge saying it holds no tunnel for it. A 403 or a missing address
        // is not a sleeping machine.
        const asleep = [`network`, `timeout`, `closed`, `detached`] as const;
        if (!(asleep as readonly string[]).includes(state.failure.kind)) {
            return;
        }
        const last = wokeAt.get(id) ?? 0;
        if (Date.now() - last < WAKE_THROTTLE_MS) {
            return;
        }
        wokeAt.set(id, Date.now());
        const box = active.value;
        if (box !== undefined) {
            noteUnreachable(box);
        }
        // allow(silent-catch): wake() already recorded the refusal for the gate and sent sandbox_wake with its outcome
        void wake(id, `switch`).catch(() => undefined);
    },
);
// A sandbox switched away from is no longer dialled, so a waking window it had closes with it.
watch(activeSandboxId, (_id, previous) => {
    if (previous !== undefined) {
        closeWakeWindow(previous);
    }
});
// A manual retry crosses the same platform gate as selection, and keeps its refusal in the active gate.
const wake = async (sandboxId: string, source: `retry` | `switch`): Promise<void> => {
    wokeAt.set(sandboxId, Date.now());
    try {
        await apiClient.sandbox.wake({ sandboxId });
        // Taken, so the sandbox is due back within seconds: the connection loop redials it every second until it answers
        // (wake/wakeWindow.ts), whether this ask came from a failure (above) or from selecting a hosted one asleep (select).
        // Only for the sandbox the loop dials, and not one whose stream already proved itself while the ask was out: a
        // list that still said asleep, or a box that came back on its own (2026-10-19).
        if (activeSandboxId.value === sandboxId && connection.value.onlineSince === undefined) {
            openWakeWindow(sandboxId, Date.now());
        }
        recordWake(sandboxId, undefined);
        collectWakeHere(sandboxes.value.find((box) => box.id === sandboxId));
        track(`sandbox_wake`, { source, outcome: `success` });
    } catch (error) {
        recordWake(sandboxId, error);
        track(`sandbox_wake`, { source, outcome: refusalKind(error) ?? `error` });
        throw error;
    }
};

// The ACTIVE sandbox's last refused wake, if its last wake was refused.
const activeWakeRefused = computed(() =>
    wakeRefused.value !== undefined && wakeRefused.value.sandboxId === active.value?.id ? wakeRefused.value : undefined,
);

// Renames and/or re-logos a sandbox (owner-only; `image: null` clears it). Named explicitly rather than taken
// from the active selection, since the two can differ mid-reconcile.
const update = async (sandboxId: string, input: { name?: string; image?: string | null }): Promise<SandboxSummary> => {
    const updated = await apiClient.sandbox.update({ sandboxId, ...input });
    await landOnList(updated);
    return updated;
};

// Points a sandbox at a URL it runs behind and makes it active; the platform stamps lastSeenAt like an announce.
const attach = async (id: string, url: string): Promise<void> => {
    const updated = await apiClient.sandbox.attach({ sandboxId: id, daemonUrl: url });
    await landOnList(updated);
    persistActive(updated.id);
};

// Removes a sandbox from this account: an owner drops the row and its tunnel, a member leaves (leaveSandbox: the
// sandbox's own member list first, then the row), and says how the sandbox's side went. Local containers keep running.
const remove = async (id: string): Promise<LeaveOutcome | undefined> => {
    const previous = queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY);
    const target = previous?.find((sandbox) => sandbox.id === id);
    if (target === undefined) {
        return undefined;
    }
    let left: LeaveOutcome | undefined;
    // Drops the row optimistically, inside the call and before its first await, so the switcher's synchronous check sees
    // it gone this tick; a failed removal restores the pre-drop rows, `removing` cleared first so the row can come back.
    removing.add(id);
    const removal = optimisticUpdate<SandboxSummary[], unknown>(
        SANDBOX_LIST_KEY,
        (live) => live.filter((sandbox) => sandbox.id !== id),
        async () => {
            if (target.role === `owner`) {
                await apiClient.sandbox.delete({ sandboxId: id });
                return;
            }
            // Loaded here and not at the top: the leave goes through the session client, which imports this module's
            // neighbours, so a static import would close a cycle (the editor-boundaries check names it).
            left = await (await import(`./leaveSandbox`)).leaveSandbox(target);
        },
        { onRollback: () => removing.delete(id), client: queryClient },
    );
    if (activeSandboxId.value === id) {
        persistActive(queryClient.getQueryData<SandboxSummary[]>(SANDBOX_LIST_KEY)?.[0]?.id);
    }
    await removal;
    removing.delete(id);
    // Removed on purpose, so not something to offer back if a later list lacks it (recovery/deviceDirectory.ts).
    if (target.daemonUrl !== null) {
        forgetAddress(target.daemonUrl);
    }
    return left;
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
        wake,
        create,
        hostedProvision,
        hostedRelease,
        update,
        attach,
        remove,
    };
}
