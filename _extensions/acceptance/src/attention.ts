import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import type { Disposable, ViewBadge } from "@intentic/extension-api";
import { ref } from "vue";
import { host } from "./host";
import { parseManifest, parseResult, resultPath, RUNS_DIR, SCAN_RUNS, SEEN_PATH } from "./runs";

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

export interface AcceptanceFinding {
    readonly runId: string;
    readonly slug: string;
    readonly verdict: "fail" | "blocked";
}

const unseen = ref<AcceptanceFinding[]>([]);

// Acknowledges an actual completed finding, never the moment its run happened to start. Including the verdict
// means a corrected result file becomes new information rather than inheriting the acknowledgement of its draft.
export const findingKey = (finding: AcceptanceFinding): string => `${finding.runId}/${finding.slug}/${finding.verdict}`;

// seen.json is `{ "results": ["<run>/<story>/<verdict>"] }`. Anything else reads as nothing acknowledged:
// malformed background bookkeeping may light a badge again, but it must never hide a failure.
export const seenResultKeys = (source: string | undefined): ReadonlySet<string> => {
    try {
        const parsed: unknown = JSON.parse(source ?? ``);
        const results = (parsed as { results?: unknown } | null)?.results;
        return Array.isArray(results) && results.every((entry) => typeof entry === `string`) ? new Set(results) : new Set();
    } catch {
        return new Set();
    }
};

export const unseenFindings = (findings: readonly AcceptanceFinding[], seen: ReadonlySet<string>): AcceptanceFinding[] =>
    findings.filter((finding) => !seen.has(findingKey(finding)));

const findings = async (): Promise<AcceptanceFinding[]> => {
    const api = host();
    const listing = WorkspaceChildrenSchema.parse(await api.sandbox.json(`/workspace/children?path=${encodeURIComponent(RUNS_DIR)}`));
    const dirs = listing.entries
        .filter((entry) => entry.type === `dir`)
        .map((entry) => entry.path)
        .toSorted((left, right) => right.localeCompare(left))
        .slice(0, SCAN_RUNS);
    const scanned = await Promise.all(
        dirs.map(async (dir) => {
            const manifest = parseManifest((await api.workspace.file(`${dir}/run.json`)) ?? ``);
            if (manifest === undefined) {
                return [];
            }
            return (
                await Promise.all(
                    manifest.stories.map(async (story): Promise<AcceptanceFinding | undefined> => {
                        const verdict = parseResult((await api.workspace.file(resultPath(manifest.runId, story.slug))) ?? ``, story)?.verdict;
                        return verdict === `fail` || verdict === `blocked` ? { runId: manifest.runId, slug: story.slug, verdict } : undefined;
                    }),
                )
            ).flatMap((finding) => (finding === undefined ? [] : [finding]));
        }),
    );
    return scanned.flat();
};

// Nothing in here may reject: it runs detached on a timer, where a throw becomes an unhandled rejection with no
// one to catch it. That includes reading the host handle — an api shape without a sandbox transport (a test
// harness, a partially wired host) must leave the badge alone rather than take the process down.
const refresh = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        unseen.value = unseenFindings(await findings(), seenResultKeys(await api.workspace.file(SEEN_PATH)));
    } catch {
        // A refused or unreachable daemon leaves the last known state standing rather than blanking the badge:
        // "we can't reach the workspace" is not "everything passed", and a flapping tile is worse than a stale one.
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
    const failed = unseen.value.filter((entry) => entry.verdict === `fail`).length;
    const blocked = unseen.value.filter((entry) => entry.verdict === `blocked`).length;
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
        const current = await findings();
        await api.workspace.write(SEEN_PATH, JSON.stringify({ results: current.map(findingKey) }));
        unseen.value = [];
    } catch {
        // See above.
    }
};
