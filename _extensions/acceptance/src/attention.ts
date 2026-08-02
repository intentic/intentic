import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { ref } from "vue";
import { host } from "./host";
import { parseManifest, parseResult, resultPath, RUNS_DIR, SCAN_RUNS, SEEN_PATH, type Verdict } from "./runs";

/* The rail badge's source. Module state owned by activate(), NOT by the view: a badge that only updated while
 * you were already looking at Acceptance would never tell you anything you didn't know. That rules out the
 * view's vue-query — it stops when the component unmounts — so this keeps its own timer, exactly as
 * pipelines/ciAttention.ts does.
 *
 * WHAT IT COUNTS is the rail's bar, not a statistic: stories that came back `fail` or `blocked` in a run you
 * have not acknowledged. A run you have already looked at contributes nothing forever after, so the tile is lit
 * only when something happened that you don't know about. */

// Slow on purpose. This drives a glance; the view's own polling serves anyone actually watching a run.
const POLL_MS = 60_000;

interface Unseen {
    readonly runId: string;
    readonly failed: number;
    readonly blocked: number;
}

const unseen = ref<Unseen[]>([]);

// Nothing in here may reject: it runs detached on a timer, where a throw becomes an unhandled rejection with no
// one to catch it. That includes reading the host handle — an api shape without a sandbox transport (a test
// harness, a partially wired host) must leave the badge alone rather than take the process down.
const refresh = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        const json = async <T>(path: string): Promise<T | undefined> => {
            try {
                return (await api.sandbox.json(path)) as T;
            } catch {
                return undefined;
            }
        };
        const text = api.workspace.file;

        const listing = await json<unknown>(`/workspace/children?path=${encodeURIComponent(RUNS_DIR)}`);
        if (listing === undefined) {
            // No runs directory yet is the ordinary first state, not an error — and not a reason to blank.
            return;
        }
        const seenAt = seenStamp(await text(SEEN_PATH));
        const dirs = WorkspaceChildrenSchema.parse(listing)
            .entries.filter((entry) => entry.type === `dir`)
            .map((entry) => entry.path)
            .toSorted((left, right) => right.localeCompare(left))
            .slice(0, SCAN_RUNS);

        const scanned = await Promise.all(
            dirs.map(async (dir) => {
                const manifest = parseManifest((await text(`${dir}/run.json`)) ?? ``);
                if (manifest === undefined || manifest.createdAt <= seenAt) {
                    return undefined;
                }
                const verdicts = await Promise.all(
                    manifest.stories.map(async (story) => parseResult((await text(resultPath(manifest.runId, story.slug))) ?? ``)?.verdict),
                );
                return tally(manifest.runId, verdicts);
            }),
        );
        unseen.value = scanned.flatMap((entry) => (entry === undefined || entry.failed + entry.blocked === 0 ? [] : [entry]));
    } catch {
        // A refused or unreachable daemon leaves the last known state standing rather than blanking the badge:
        // "we can't reach the workspace" is not "everything passed", and a flapping tile is worse than a stale one.
    }
};

const tally = (runId: string, verdicts: readonly (Verdict | undefined)[]): Unseen => ({
    runId,
    failed: verdicts.filter((verdict) => verdict === `fail`).length,
    blocked: verdicts.filter((verdict) => verdict === `blocked`).length,
});

// seen.json is `{ "at": <ms> }`. Anything else — absent, truncated, written by hand — reads as "never
// acknowledged", which shows a badge the user can clear rather than silently hiding a failure.
const seenStamp = (text: string | undefined): number => {
    try {
        const parsed: unknown = JSON.parse(text ?? ``);
        const at = (parsed as { at?: unknown } | null)?.at;
        return typeof at === `number` ? at : 0;
    } catch {
        return 0;
    }
};

// Started by activate() so the badge is live from login, and disposed with the extension.
export const startAcceptanceAttention = (): Disposable => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return { dispose: () => clearInterval(timer) };
};

// Read inside the host's render computed — touching `unseen` here is what repaints the tile.
export const acceptanceBadge = (): ViewBadge | undefined => {
    const failed = unseen.value.reduce((total, entry) => total + entry.failed, 0);
    const blocked = unseen.value.reduce((total, entry) => total + entry.blocked, 0);
    if (failed + blocked === 0) {
        return undefined;
    }
    const parts = [...(failed > 0 ? [`${failed} failed`] : []), ...(blocked > 0 ? [`${blocked} blocked`] : [])];
    // `danger` only when a criterion actually failed. Blocked alone means the run never got to judge the story —
    // a thing to look at, not a broken promise — so it takes the tone that says "carry this", not "it's broken".
    return { count: failed + blocked, tone: failed > 0 ? `danger` : `warning`, tooltip: `${parts.join(`, `)} since you last looked` };
};

// Called when the view is opened — opening IS reading, so the badge clears on the spot rather than at the next
// poll. Best-effort, like the fleet board's markSeen: a failed write only means the badge returns in a minute,
// which is a far smaller harm than an error surfacing from background bookkeeping.
export const markAcceptanceSeen = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        unseen.value = [];
        await api.workspace.write(SEEN_PATH, JSON.stringify({ at: Date.now() }));
    } catch {
        // See above.
    }
};
