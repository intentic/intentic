import type { WorkspaceModule } from "@intentic/sandbox-contract";

// Groups a change list by module (longest matching dir wins) instead of by path, so a review reads by system area.
// Shared by the Changes panel and the fleet's agent review so the two never define buckets differently.

// Longest matching module dir wins, so a nested package claims its own files before its parent.
// dir "" claims what nothing deeper claims; the trailing separator keeps `_apps/webx` from matching `_editor/web`.
export const moduleOf = (path: string, modules: readonly WorkspaceModule[]): WorkspaceModule | undefined => {
    let best: WorkspaceModule | undefined;
    for (const candidate of modules) {
        if (candidate.dir !== `` && !path.startsWith(`${candidate.dir}/`)) {
            continue;
        }
        if (best === undefined || candidate.dir.length > best.dir.length) {
            best = candidate;
        }
    }
    return best;
};

export interface ModuleGroup<T> {
    readonly key: string;
    readonly name: string;
    // True for a real package manifest; false for the fallback bucket of paths no module claims.
    readonly packaged: boolean;
    readonly rows: readonly T[];
}

// Groups rows by module in first-appearance order, so a git-sorted list keeps its path order.
export const moduleGroups = <T>(
    rows: readonly T[],
    pathOf: (row: T) => string,
    modules: readonly WorkspaceModule[],
    fallbackName: string,
): readonly ModuleGroup<T>[] => {
    const grouped = new Map<string, { key: string; name: string; packaged: boolean; rows: T[] }>();
    for (const row of rows) {
        const found = moduleOf(pathOf(row), modules);
        // Key `repo` can't collide with `module:${dir}`, even for dir "", so the fallback bucket stays distinct.
        const key = found === undefined ? `repo` : `module:${found.dir}`;
        const bucket = grouped.get(key);
        if (bucket === undefined) {
            grouped.set(key, { key, name: found?.name ?? fallbackName, packaged: found !== undefined, rows: [row] });
            continue;
        }
        bucket.rows.push(row);
    }
    return [...grouped.values()];
};

// Whether each bucket gets a heading: a lone bucket of unclaimed files would repeat the repo name, so it stays
// unheaded; every other case is headed.
// Generic over the bucket, not the row, so a caller can attach its own per-bucket data to ModuleView<ItsBucket>.
export interface ModuleView<B> {
    readonly buckets: readonly B[];
    readonly named: boolean;
}

export const moduleView = <T>(
    rows: readonly T[],
    pathOf: (row: T) => string,
    modules: readonly WorkspaceModule[],
    fallbackName: string,
    // The reader's preference (useChangeGrouping); off collapses to one unnamed bucket, the plain path list.
    grouped: boolean,
): ModuleView<ModuleGroup<T>> => {
    if (!grouped) {
        return { buckets: [{ key: `all`, name: ``, packaged: false, rows }], named: false };
    }
    const buckets = moduleGroups(rows, pathOf, modules, fallbackName);
    return { buckets, named: buckets.length > 1 || buckets[0]?.packaged === true };
};

// Shared empty view so neither panel invents its own (and it is never accidentally `named`).
export const EMPTY_MODULE_VIEW: ModuleView<never> = { buckets: [], named: false };
