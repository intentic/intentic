import { HelloSchema, PresenceSchema } from "@intentic/sandbox-contract";
import { watch } from "vue";
import { readIntenticLines } from "../intenticStream";
import { queryClient } from "../queryPersistence";
import { sandboxRequest } from "../sandboxClient";
import { presenceStreamOpened, resetPresence, setPresenceUsers } from "../usePresence";
import { useSandbox } from "../useSandbox";
import { markWorkspaceChanged } from "../workspace/useWorkspaceLive";

// No heartbeat for this long means the connection silently half-opened (origin gone without a TCP FIN) — trip
// offline. The daemon emits a heartbeat every ~2s, so this tolerates ~2 missed beats before reconnecting.
const WATCHDOG_MS = 6000;
// Reconnect backoff while the sandbox is down — fast first retry (a restart should reconnect quickly), capped.
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 5000;

/* Keeps useSandbox().reachable live by holding a single long-lived SSE stream open to the sandbox daemon
 * (`/events`), instead of polling. A killed sandbox breaks the stream — detected instantly (or within the
 * watchdog window for a silent half-open) — and the reconnect loop recovers once the sandbox is back. Started
 * by the workspace shell for the lifetime of the post-login session. Module-level singleton. */

const { daemonUrl, reachable, denied, probeError, refresh, activeSandboxId } = useSandbox();

let running = false;
let controller: AbortController | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
let backoff = BACKOFF_MIN_MS;
// Set by the active-sandbox watch so the loop can tell a deliberate switch-abort apart from a stream failure —
// a switch reconnects immediately instead of paying list() + backoff.
let switched = false;
// Resolver of the in-flight wait(), so a sandbox switch cuts a backoff sleep short instead of stalling the
// reconnect against the new daemon for up to BACKOFF_MAX_MS.
let wake: (() => void) | undefined;
// Last observed reachability per sandbox id: switching back to a recently-healthy sandbox renders the
// workspace immediately (stale-while-revalidate) while the stream re-establishes; a wrong guess self-corrects
// on the first failed connect or watchdog trip.
const lastKnown = new Map<string, boolean>();

const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, ms);
    });

const clearWatchdog = (): void => {
    if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
    }
};

const armWatchdog = (): void => {
    clearWatchdog();
    watchdog = setTimeout(() => {
        reachable.value = false;
        controller?.abort();
    }, WATCHDOG_MS);
};

// Open the stream and consume heartbeat frames until it ends or breaks. Each frame (and the initial open)
// marks the sandbox reachable and re-arms the watchdog. Returning normally means the stream ended cleanly.
const stream = async (): Promise<void> => {
    controller = new AbortController();
    // Armed before the connect, not just after: with optimistic reachability a hung connect (dead tunnel that
    // neither answers nor refuses) must not leave a stale UI up — the watchdog trips it offline and aborts.
    armWatchdog();
    // Per-CONNECTION presence id, never reused across attempts: the daemon keys this tab's roster entry by it,
    // so a lingering old connection's teardown can only ever remove its own entry, never this one's.
    const clientId = crypto.randomUUID();
    const response = await sandboxRequest(`/events?clientId=${clientId}`, { signal: controller.signal });
    // 403 = the daemon is up but rejects this Google account (not the owner/a member) — surfaced as its own
    // gate instead of "connecting". One assignment both sets and clears; a network throw above skips it, so a
    // denied sandbox going offline stays denied until the next resolved probe.
    denied.value = response.status === 403;
    if (denied.value) {
        // A revoked member must not keep a cached (IndexedDB-persisted) copy of the sandbox. The sandbox id is
        // the LAST key element (sandboxKey appends it), so prefix matching can't scope this — use a predicate.
        queryClient.removeQueries({ predicate: (query) => query.queryKey.at(-1) === activeSandboxId.value });
    }
    if (!response.ok || response.body === null) {
        throw new Error(`liveness stream failed (${response.status})`);
    }
    reachable.value = true;
    probeError.value = undefined;
    // A confirmed-healthy connection earns back the fast first retry; the reset lives here because a healthy
    // stream never returns cleanly — it blocks on heartbeats until aborted, which throws.
    backoff = BACKOFF_MIN_MS;
    armWatchdog();
    // The daemon just registered this connection's blank roster entry — announce the tab's current activity.
    presenceStreamOpened(clientId);
    // Reconnect recovery: refetch the tree on every (re)connect, since file changes during a disconnect carried
    // no frame. Empty paths = "just refetch" (no per-file re-read/highlight — we don't know what was missed).
    markWorkspaceChanged([]);
    for await (const frame of readIntenticLines(response.body)) {
        reachable.value = true;
        armWatchdog();
        // The stream's first frame carries the workspace's stable identity. A different id under the SAME
        // sandbox id means the workspace was wiped and recreated (cleanup.sh + reconnect reuses the slug) —
        // the persisted cache is the previous workspace's data, not a stale copy of this one. Reset (not
        // remove: active observers must refetch) every query of this sandbox; same last-key predicate as the
        // denied purge above.
        if (frame[`kind`] === `hello`) {
            const parsed = HelloSchema.safeParse(frame);
            const sandboxId = activeSandboxId.value;
            if (parsed.success && sandboxId !== undefined) {
                const storageKey = `intentic.workspaceId.${sandboxId}`;
                const known = localStorage.getItem(storageKey);
                if (known !== null && known !== parsed.data.workspaceId) {
                    void queryClient.resetQueries({ predicate: (query) => query.queryKey.at(-1) === sandboxId });
                }
                localStorage.setItem(storageKey, parsed.data.workspaceId);
            }
            continue;
        }
        // Live file-change push: the daemon interleaves workspaceChanged batches with the heartbeats. Heartbeats
        // just re-arm the watchdog (above); a change batch refreshes the tree + any open file.
        // Presence roster snapshot: validate against the contract schema (no hand-narrowing drift) and hand
        // it to the singleton store every presence surface reads.
        if (frame[`kind`] === `presence`) {
            const parsed = PresenceSchema.safeParse(frame);
            if (parsed.success) {
                setPresenceUsers(parsed.data.users);
            }
            continue;
        }
        const paths = frame[`paths`];
        if (frame[`kind`] === `workspaceChanged` && Array.isArray(paths)) {
            const changed = paths.filter((path): path is string => typeof path === `string`);
            markWorkspaceChanged(changed);
            // Cross-user freshness for the .intentic/-backed views: another member's capability/automation/
            // setting write lands as a file change here, but those queries only refetch on their OWN mutations —
            // invalidate them so every connected browser converges without a remount.
            if (changed.some((path) => path.startsWith(`.intentic/`))) {
                for (const key of [`capabilities`, `environment`, `panels`, `automations`, `automation-approvals`, `settings`]) {
                    void queryClient.invalidateQueries({ queryKey: [key] });
                }
            }
            // A repo folder added/removed/renamed under repositories/ changes the rail's panel list. Chokidar emits
            // it as the bare dir path (repositories/monorepo); match direct children only so deep file edits inside a
            // repo — constant during agent work — don't needlessly refetch panels.
            if (changed.some((path) => /^repositories\/[^/]+$/.test(path))) {
                void queryClient.invalidateQueries({ queryKey: [`panels`] });
            }
        }
    }
    clearWatchdog();
};

const loop = async (): Promise<void> => {
    while (running) {
        // Need the daemon's address to open the stream — reload the sandbox list if we don't have it yet.
        // A rejected platform call must not escape the loop (it would kill liveness for good, with `running`
        // still true so start() never restarts it) — swallow and let the backoff below retry.
        if (daemonUrl.value === undefined) {
            await refresh().catch(() => undefined);
        }
        if (daemonUrl.value === undefined) {
            await wait(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
            continue;
        }
        try {
            switched = false;
            await stream();
        } catch (error) {
            if (!running) {
                return;
            }
            // A deliberate switch is not a failure: the new daemonUrl is already in the loaded list and the
            // watch already primed `reachable` — reconnect immediately, no list() round-trip, no backoff.
            if (switched) {
                continue;
            }
            reachable.value = false;
            // A disconnected roster is meaningless — clear it; the reconnect's immediate snapshot repaints it.
            resetPresence();
            // Switch-aborts were handled above, so an AbortError here is the watchdog's: no response within the
            // watchdog window — a cause worth naming, and the signal that flips the shell from cached paint to
            // the connecting gate (probeError !== undefined ⇔ a connect attempt actually failed).
            probeError.value =
                error instanceof DOMException && error.name === `AbortError`
                    ? `The sandbox stopped responding.`
                    : error instanceof Error
                      ? error.message
                      : String(error);
            // A restarted sandbox may have re-registered a fresh daemonUrl — pick it up before retrying.
            // Swallowed on failure for the same reason as the loop-top refresh: the retry handles it.
            await refresh().catch(() => undefined);
            await wait(backoff);
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        }
    }
};

const start = (): void => {
    if (running) {
        return;
    }
    running = true;
    void loop();
};

const stop = (): void => {
    running = false;
    controller?.abort();
    clearWatchdog();
};

// Re-probe the moment the active sandbox changes: remember the outgoing sandbox's state, prime `reachable`
// with the incoming one's last known state (never-seen stays pessimistic, so the connecting gate shows), and
// abort the stream / wake the backoff sleep so the loop reconnects against the new daemonUrl right away.
watch(activeSandboxId, (id, previous) => {
    if (previous !== undefined) {
        lastKnown.set(previous, reachable.value);
    }
    reachable.value = id !== undefined && (lastKnown.get(id) ?? false);
    denied.value = false;
    probeError.value = undefined;
    switched = true;
    controller?.abort();
    wake?.();
});

export function useSandboxLiveness() {
    return { start, stop };
}
