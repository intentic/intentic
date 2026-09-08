import { WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import type { IntenticApi, ViewBadge } from "@intentic/extension-api";
import { sandboxLedger, sandboxPoll } from "@intentic/extension-api";
import { host } from "./host";
import { parseManifest, parseResult, resultPath, RUNS_DIR, SCAN_RUNS, SEEN_PATH } from "./runs";

// The rail badge's source: stories that came back fail/blocked in a run the owner hasn't acknowledged yet. An
// already-seen run contributes nothing forever after, so the tile lights only for something new.

export interface AcceptanceFinding {
    readonly runId: string;
    readonly slug: string;
    readonly verdict: "fail" | "blocked";
}

// Keyed by story-within-run, marked by the verdict acknowledged at: a result corrected from blocked to fail is new
// information, not inherited from its draft's acknowledgement. A run still in flight has no completed result, so
// nothing to acknowledge yet.
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

// Module state owned by activate(), not the view, so the badge updates even while Acceptance isn't open. Driven by the
// file binding over the runs directory (result.json is the finding, seen.json the acknowledgement); the scan is
// generously slow since it is the widest of any badge.
const { state: unseen, start: startAcceptanceAttention } = sandboxPoll<AcceptanceFinding[]>({
    host,
    everyMs: 10 * 60_000,
    initial: () => [],
    read: async (api) => unseenFindings(await findings(api), await seen.read()),
});

// Started by activate() so the badge is live from login, and disposed with the extension.
export { startAcceptanceAttention };

// Read inside the host's render computed; touching `unseen` here is what repaints the tile.
export const acceptanceBadge = (): ViewBadge | undefined => {
    const failed = unseen.value.filter((entry) => entry.verdict === `fail`).length;
    const blocked = unseen.value.filter((entry) => entry.verdict === `blocked`).length;
    if (failed + blocked === 0) {
        return undefined;
    }
    const parts = [...(failed > 0 ? [`${failed} failed`] : []), ...(blocked > 0 ? [`${blocked} blocked`] : [])];
    // `danger` only when a criterion failed; blocked alone means unjudged, not a broken promise.
    return { count: failed + blocked, tone: failed > 0 ? `danger` : `warning`, tooltip: `${parts.join(`, `)} since you last looked` };
};

// Opening the view clears the badge immediately, best-effort (a failed write just delays it a minute). Replaces rather
// than merges the ledger, since a story in a run older than SCAN_RUNS can never resurface and would otherwise
// accumulate forever.
export const markAcceptanceSeen = async (): Promise<void> => {
    try {
        const api = host();
        if (!api.sandbox.reachable()) {
            return;
        }
        // Cleared only if the write landed, so a mid-write switch doesn't silence the new ledger's tile early.
        if (await seen.replace(acknowledgement(await findings(api)))) {
            unseen.value = [];
        }
    } catch {
    }
};
