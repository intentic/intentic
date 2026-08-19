import type { HostQuery } from "@intentic/extension-api";
import { type ChoresReport, ChoresReportSchema, WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { host } from "./host";
import { parseManifest, parseResult, resultPath, type RunManifest, type RunResult, RUNS_DIR, SCAN_RUNS } from "./runs";

/* THE TWO READS THIS SURFACE OPENS ON, described in one place so that everything which needs them names the
 * same cache entry.
 *
 * Three things want the chore report, and they used to be three separate reads of the same route: the panel
 * (through its own useQuery), the rail badge (on a ten-minute timer, keeping the answer to itself), and — now —
 * the host's background loader reading ahead of a click. The badge's poll being private was the expensive one:
 * it fetched exactly what the panel renders, six times an hour, and the panel still started from nothing every
 * time it was opened. Filed under one key, that poll IS the panel's first paint.
 *
 * The runs list is the slower of the two and the reason warming this view is worth anything. It walks the run
 * directory and then reads TWO files per run, so it is the read most likely to be the visible wait — and it is
 * pure history, which is exactly the kind of answer that is worth having before it is asked for. */

const reportFn = async (): Promise<ChoresReport> => ChoresReportSchema.parse(await host().sandbox.json(`/chores`));

// The key's first segment is what the manifest's `contributes.files` invalidation for .intentic/records/chores/ names,
// so a probe the background runner just wrote reaches every one of the three readers above at once.
export const choresReportQuery = (): HostQuery<ChoresReport> => ({ queryKey: host().sandbox.key(`maintenance-report`), queryFn: reportFn });

export interface StoredRun {
    readonly manifest: RunManifest;
    readonly result: RunResult | undefined;
}

const runsFn = async (): Promise<StoredRun[]> => {
    const api = host();
    // No runs directory yet is the ordinary first state, not an error.
    const listing = await api.sandbox.json<unknown>(`/workspace/children?path=${encodeURIComponent(RUNS_DIR)}`).catch(() => undefined);
    if (listing === undefined) {
        return [];
    }
    const dirs = WorkspaceChildrenSchema.parse(listing)
        .entries.filter((entry) => entry.type === `dir`)
        // Run ids sort by their base-36 timestamp, so newest-first is a reverse lexical sort — no manifest
        // read needed to decide which SCAN_RUNS to read at all.
        .toSorted((left, right) => right.path.localeCompare(left.path))
        .slice(0, SCAN_RUNS);
    const runs = await Promise.all(
        dirs.map(async (entry) => {
            const text = await api.workspace.file(`${entry.path}/run.json`);
            const manifest = text === undefined ? undefined : parseManifest(text);
            if (manifest === undefined) {
                return undefined;
            }
            const resultText = await api.workspace.file(resultPath(manifest.runId));
            return { manifest, result: resultText === undefined ? undefined : parseResult(resultText) };
        }),
    );
    return runs.flatMap((run) => (run === undefined ? [] : [run])).toSorted((left, right) => right.manifest.createdAt - left.manifest.createdAt);
};

export const choresRunsQuery = (): HostQuery<StoredRun[]> => ({ queryKey: host().sandbox.key(`maintenance-runs`), queryFn: runsFn });
