import type { HostQuery } from "@intentic/extension-api";
import { type ChoresReport, ChoresReportSchema, WorkspaceChildrenSchema } from "@intentic/sandbox-contract";
import { host } from "./host";
import { parseManifest, parseResult, resultPath, type RunManifest, type RunResult, RUNS_DIR, SCAN_RUNS } from "./runs";

// The two reads this surface opens on, under one cache key each so the panel, the rail badge and the background loader
// share one fetch. The chore report is what all three want; the runs list is slower (a directory walk plus two file
// reads per run) and purely historical, worth warming ahead of a click.

const reportFn = async (): Promise<ChoresReport> => ChoresReportSchema.parse(await host().sandbox.json(`/chores`));

// Key's first segment matches the manifest's `contributes.files` invalidation for .intentic/records/chores/, reaching
// all three readers at once.
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
        // Run ids are base-36 timestamps; reverse lexical sort is newest-first without reading any manifest.
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
