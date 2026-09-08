import { sandboxRouteAllowed } from "@intentic/extension-manifest";
import { jsonBody } from "../features/sandbox/client/jsonBody";
import { sandboxJson } from "../features/sandbox/client/sandboxClient";

// Counts which declared permissions.sandbox entry a call used, batched and reported to the daemon; lives in the browser
// because the daemon can't attribute an authenticated request to an extension or entry.
// Counts the entry, not the path: `GET /workspace/file?path=...` collapses onto the manifest line `GET /workspace/file`
// that permitted it.
// Batched on a timer to avoid a request per call; losing the last few seconds to a hard close is acceptable since this
// measures usage over days.

// Long enough to fold a burst into one request, short enough that figures are fresh when the tab opens.
const FLUSH_MS = 15_000;

// extension routing id → declared entry → calls since the last successful report.
const pending = new Map<string, Map<string, number>>();
let timer: ReturnType<typeof setTimeout> | undefined;

// Which declared entry permitted this call, found by asking one entry at a time rather than extending the SDK's matcher
// to report its match.
const matchedEntry = (permissions: readonly string[], method: string, path: string): string | undefined =>
    permissions.find((entry) => sandboxRouteAllowed([entry], method, path));

export const flushSandboxUsage = async (): Promise<void> => {
    if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
    }
    // Taken before awaiting, so calls made during the flush queue for the next one instead of being dropped.
    const batches = [...pending.entries()];
    pending.clear();
    if (batches.length === 0) {
        return;
    }
    try {
        await sandboxJson(
            `/extensions/usage`,
            jsonBody(`POST`, { reports: Object.fromEntries(batches.map(([id, batch]) => [id, Object.fromEntries(batch)])) }),
        );
    } catch {
        // Re-queues on failure: a briefly unreachable daemon must not cost the evidence, and counts are bounded by the
        // manifests' own lists so this can't grow without limit.
        // Swallowed rather than surfaced, since this is bookkeeping behind someone else's feature.
        for (const [id, batch] of batches) {
            const again = pending.get(id) ?? new Map<string, number>();
            for (const [entry, calls] of batch) {
                again.set(entry, (again.get(entry) ?? 0) + calls);
            }
            pending.set(id, again);
        }
    }
};

// Called from the gate on every api.sandbox call; cheap, two map lookups and an increment.
// An undeclared call never reaches here (the gate throws first); matchedEntry returning nothing means the two matchers
// disagreed, so nothing is recorded.
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

// pagehide, not beforeunload (a bfcache-eligible page may never fire it); visibilitychange covers a backgrounded mobile
// page killed without unloading.
// Registered once at module load, since the state being flushed outlives every component that caused it.
if (typeof document !== `undefined`) {
    addEventListener(`pagehide`, () => void flushSandboxUsage());
    document.addEventListener(`visibilitychange`, () => {
        if (document.visibilityState === `hidden`) {
            void flushSandboxUsage();
        }
    });
}
