import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { ref } from "vue";
import { host } from "./host.js";
import { SEEN_PATH, stagingKey } from "./paths.js";
import { listStagedTails } from "./stagedTree.js";

/* THE RAIL BADGE, and the one thing it is deliberately NOT.
 *
 * It is not a coverage count. "38 packages undocumented" would be lit every day for months, and the extension API
 * is explicit about why that is a bug rather than information: a badge "must mean something happened here that you
 * don't already know about, never here is a statistic", because a tile that is always lit teaches the eye to stop
 * seeing the rail. Staleness is the same shape — in an active repo something is always drifting — so it lives
 * inside the view, as a number next to the thing it describes.
 *
 * What it counts instead is a document set that has been GENERATED AND NOT YET REVIEWED: a run finished, drafts are
 * sitting in staging, and nobody has looked. That is an event, it is addressed to the person seeing it, and it
 * clears by acting — reviewing, publishing or discarding — rather than by waiting.
 *
 * Module state owned by activate(), not by the view, and its own timer rather than the view's query: a badge that
 * only updated while you were already looking at Documentation could never tell you anything you did not know.
 * The file-change push cannot serve this either — invalidation only reaches a query something is observing, and
 * nothing observes an unmounted view. */

// Slow on purpose. This drives a glance; the view's own reads serve anyone actually watching a run.
const POLL_MS = 60_000;

// Repos whose staged set is present and unacknowledged.
const pending = ref<readonly string[]>([]);

// No file yet is the ordinary first state: nothing has been reviewed because nothing has been generated — which
// is what api.workspace.readJson answers undefined for.
const readSeen = async (): Promise<Record<string, number>> => (await host().workspace.readJson<Record<string, number>>(SEEN_PATH)) ?? {};

/* Never throws, and never rejects. This runs on a timer that nothing awaits, so a failure here has no caller to
 * report to — it would surface as an unhandled rejection in the console of an app that is otherwise fine. It also
 * runs at ACTIVATION, which is before the shell has a sandbox at all, so "the host is not ready yet" is an
 * ordinary first state rather than an error: the next tick picks it up. */
const scan = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        const seen = await readSeen();
        const repos = api.workspace.repos().map((repo) => repo.repo);
        const staged = await Promise.all(
            repos.map(async (repo) => {
                const tails = await listStagedTails(api, repo);
                // A `repo.json` is the marker that a set is worth reviewing: a run that has only just started has
                // a run manifest but no map yet, and lighting the rail for that would badge the user's own click
                // back at them.
                return tails.includes(`repo.json`) && seen[stagingKey(repo)] === undefined ? repo : undefined;
            }),
        );
        pending.value = staged.filter((repo): repo is string => repo !== undefined);
    } catch {
        // Leave the previous verdict standing: a transient read failure is not evidence that nothing is waiting.
    }
};

export const startDocumentationAttention = (): Disposable => {
    void scan();
    const timer = setInterval(() => void scan(), POLL_MS);
    return { dispose: () => clearInterval(timer) };
};

export const documentationBadge = (): ViewBadge | undefined => {
    const count = pending.value.length;
    if (count === 0) {
        return undefined;
    }
    return {
        count,
        // `info` is the resting tone every core count uses. Nothing is broken and nothing is at risk — there is
        // reading waiting, which is the mildest possible claim on attention.
        tone: `info`,
        tooltip: `${count} repositor${count === 1 ? `y has` : `ies have`} newly generated documentation waiting to be reviewed`,
    };
};

/* Acknowledge a repo's staged set — called when the owner actually opens it. Written to a file rather than held in
 * memory or in an extension setting: the badge is derived from files, so its acknowledgement belongs in the same
 * tree, where it survives a reload and is shared across the owner's browsers without adding a setting no user
 * would ever type. */
export const acknowledgeStaged = async (repo: string): Promise<void> => {
    const api = host();
    const seen = await readSeen();
    const next = { ...seen, [stagingKey(repo)]: Date.now() };
    await api.workspace.write(SEEN_PATH, `${JSON.stringify(next, undefined, 2)}\n`);
    pending.value = pending.value.filter((entry) => entry !== repo);
};
