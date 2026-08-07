import { sandboxRouteAllowed } from "@intentic/extension-api";
import { jsonBody } from "../composables/sandbox/jsonBody";
import { sandboxJson } from "../composables/sandbox/sandboxClient";

/* WHICH DECLARED ROUTE A CALL USED, counted here and reported to the daemon in batches.
 *
 * The permission gate in apiImpl already decides, for every api.sandbox call, whether some entry in the
 * extension's `permissions.sandbox` covers it. This keeps that answer instead of throwing it away, and it has to
 * live in the browser for the same reason the gate does: the daemon receives an extension's traffic as ordinary
 * authenticated requests on the owner's session and cannot tell which extension — let alone which declared entry
 * — any of it belongs to.
 *
 * IT COUNTS THE ENTRY, NOT THE PATH. `GET /workspace/file?path=…` collapses onto the manifest line
 * `GET /workspace/file` that permitted it. That is what makes a figure actionable (the line is what an author
 * deletes) and it is also the difference between evidence and a log of what the owner was reading.
 *
 * BATCHED, because the alternative is a request per request. A view that polls would otherwise double the
 * traffic it costs, to record a counter nobody watches change — so calls accumulate in memory and go out on a
 * timer, and on the way out of the page. Losing the last few seconds of counts to a hard close is a cost worth
 * paying: this measures whether a permission is used at all, over days, and no decision it feeds turns on one
 * call. */

// Long enough that a burst of calls costs one request, short enough that the figures are there when someone
// opens the tab a moment after using the extension.
const FLUSH_MS = 15_000;

// extension routing id → declared entry → calls since the last successful report.
const pending = new Map<string, Map<string, number>>();
let timer: ReturnType<typeof setTimeout> | undefined;

/* Which declared entry permitted this call. Asked one entry at a time rather than by teaching the SDK's matcher
 * to report its match: the list is a handful of strings, this runs after the gate has already said yes, and the
 * alternative is a new export on a published package for the benefit of one caller. */
const matchedEntry = (permissions: readonly string[], method: string, path: string): string | undefined =>
    permissions.find((entry) => sandboxRouteAllowed([entry], method, path));

const flushOne = async (id: string, batch: Map<string, number>): Promise<void> => {
    const used = Object.fromEntries(batch);
    try {
        await sandboxJson(`/extensions/${encodeURIComponent(id)}/usage`, jsonBody(`POST`, { used }));
    } catch {
        /* Put it back. A daemon that was briefly unreachable must not cost the evidence — and the counts are
         * bounded by the manifest's own list, so re-queuing cannot grow without limit however long it lasts.
         * Swallowed rather than surfaced: this is bookkeeping behind someone else's feature, and an extension
         * whose calls are working should not report an error because their tally did not. */
        const again = pending.get(id) ?? new Map<string, number>();
        for (const [entry, calls] of batch) {
            again.set(entry, (again.get(entry) ?? 0) + calls);
        }
        pending.set(id, again);
    }
};

export const flushSandboxUsage = async (): Promise<void> => {
    if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
    }
    // Taken before awaiting anything, so calls made during the flush queue for the next one instead of being
    // dropped by a clear that raced them.
    const batches = [...pending.entries()];
    pending.clear();
    await Promise.all(batches.map(([id, batch]) => flushOne(id, batch)));
};

/* Record one permitted call. Called from the gate, so it is on the path of every api.sandbox call an extension
 * makes and does nothing but two map lookups and an increment.
 *
 * An undeclared call never reaches here — the gate throws first — so `matchedEntry` returning nothing means the
 * two matchers disagreed, and recording an unattributable call is worse than recording none. */
export const recordSandboxCall = (id: string, permissions: readonly string[], method: string, path: string): void => {
    const entry = matchedEntry(permissions, method, path);
    if (entry === undefined) {
        return;
    }
    const batch = pending.get(id) ?? new Map<string, number>();
    batch.set(entry, (batch.get(entry) ?? 0) + 1);
    pending.set(id, batch);
    timer ??= setTimeout(() => void flushSandboxUsage(), FLUSH_MS);
};

/* The last chance to report. `pagehide` rather than `beforeunload` (which a bfcache-eligible page may never
 * fire) and `visibilitychange` for the mobile case, where a page is backgrounded and killed without ever
 * "unloading". Registered once at module load, beside the app rather than inside a component, because the thing
 * being flushed outlives every component that caused it. */
if (typeof document !== `undefined`) {
    addEventListener(`pagehide`, () => void flushSandboxUsage());
    document.addEventListener(`visibilitychange`, () => {
        if (document.visibilityState === `hidden`) {
            void flushSandboxUsage();
        }
    });
}
