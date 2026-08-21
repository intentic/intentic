import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import type { IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxLedger, sandboxPoll } from "@intentic/extension-api";
import { host } from "./host";
import { parseManifest, parseResult, resultPath, RUNS_DIR, SCAN_RUNS, SEEN_PATH } from "./runs";

/* The rail badge's source: stories that came back `fail` or `blocked` in a run the owner has not acknowledged.
 * A run already looked at contributes nothing forever after, so the tile is lit only when something happened
 * that they don't know about, the rail's bar, rather than a statistic. */

export interface AcceptanceFinding {
    readonly runId: string;
    readonly slug: string;
    readonly verdict: "fail" | "blocked";
}

/* A COMPARING LEDGER: the key is the story within its run, and the mark is the VERDICT it was acknowledged at.
 *
 * That split is the whole subtlety of this file, and it used to be smuggled into a composite key. Acknowledging
 * a story means acknowledging what it SAID, so a result file corrected from `blocked` to `fail` is new
 * information rather than something inheriting the acknowledgement of its draft, which falls straight out of a
 * mark comparison. It also means a run still in flight acknowledges nothing: a story with no completed result
 * is not a finding, so there is no entry to write. */
const seen = sandboxLedger(host, SEEN_PATH);

export const findingKey = (finding: AcceptanceFinding): string => `${finding.runId}/${finding.slug}`;

export const unseenFindings = (findings: readonly AcceptanceFinding[], acknowledged: Readonly<Record<string, string>>): AcceptanceFinding[] =>
    findings.filter((finding) => acknowledged[findingKey(finding)] !== finding.verdict);

export const acknowledgement = (findings: readonly AcceptanceFinding[]): Record<string, string> =>
    Object.fromEntries(findings.map((finding) => [findingKey(finding), finding.verdict]));

const findings = async (api: IntenticApi): Promise<AcceptanceFinding[]> => {
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

/* Module state owned by activate(), NOT by the view: a badge that only updated while you were already looking
 * at Acceptance would never tell you anything you didn't know (background.ts).
 *
 * DRIVEN BY THE FILE BINDING the manifest declares over the runs directory, which is where every input to this
 * answer is written: an agent's `result.json` landing is the finding, and `seen.json` is the acknowledgement. The
 * binding is new, and its absence is why this tile was the last one still learning about a failed story from a
 * timer, up to a minute after the run had already written the verdict to disk.
 *
 * `everyMs` is now the frame nobody delivered, and slow for a second reason: this read is the widest of any badge
 * in the workspace, a directory of runs plus two files per story. The wake coalesces a burst (background.ts), so a
 * run writing a result per story costs one scan rather than one per story. */
const { state: unseen, start: startAcceptanceAttention } = sandboxPoll<AcceptanceFinding[]>({
    host,
    everyMs: 10 * 60_000,
    initial: () => [],
    read: async (api) => unseenFindings(await findings(api), await seen.read()),
});

// Started by activate() so the badge is live from login, and disposed with the extension.
export { startAcceptanceAttention };

// Read inside the host's render computed, touching `unseen` here is what repaints the tile.
export const acceptanceBadge = (): ViewBadge | undefined => {
    const failed = unseen.value.filter((entry) => entry.verdict === `fail`).length;
    const blocked = unseen.value.filter((entry) => entry.verdict === `blocked`).length;
    if (failed + blocked === 0) {
        return undefined;
    }
    const parts = [...(failed > 0 ? [`${failed} failed`] : []), ...(blocked > 0 ? [`${blocked} blocked`] : [])];
    // `danger` only when a criterion actually failed. Blocked alone means the run never got to judge the story,
    // a thing to look at, not a broken promise, so it takes the tone that says "carry this", not "it's broken".
    return { count: failed + blocked, tone: failed > 0 ? `danger` : `warning`, tooltip: `${parts.join(`, `)} since you last looked` };
};

/* Called when the view is opened, opening IS reading, so the badge clears on the spot rather than at the next
 * poll. Best-effort: a failed write only means the badge returns in a minute, which is a far smaller harm than
 * an error surfacing from background bookkeeping.
 *
 * REPLACE, not merge, and this is the one ledger here that needs it: the keys go out of scope. Only the newest
 * runs are ever scanned (SCAN_RUNS), so a story in a run that has scrolled past that window can never be seen
 * again, and merging forever would grow this file with every run the workspace has ever done. */
export const markAcceptanceSeen = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        // Cleared only if the acknowledgement landed: a switch mid-write abandons it, and blanking here anyway
        // would silence the NEW box's tile for runs read in the old one.
        if (await seen.replace(acknowledgement(await findings(api)))) {
            unseen.value = [];
        }
    } catch {
        // See above.
    }
};
