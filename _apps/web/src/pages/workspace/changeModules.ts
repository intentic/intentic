import type { WorkspaceModule } from "@intentic/sandbox-contract";

/* Reading a change list by MODULE rather than by path. A review's first question is "which parts of the system
 * did this touch", and a flat list of repo-relative paths answers it only by making the reader re-derive the
 * grouping from thirty repeated prefixes — in a sidebar where the prefix is also the half that truncates away.
 *
 * So the module becomes the HEADER and the file keeps the row. The inverse (a module name per row) was the
 * obvious reading of "show modules instead of paths" and is the wrong one: nine consecutive rows reading
 * "@intentic/desktop" say nothing about the thing you are about to click.
 *
 * Modules come from the daemon (workspace/modules.ts); everything here is the pure mapping the panels share. */

// The module a repo-relative path belongs to: the longest module dir that prefixes it, so a package nested
// inside another (an app with its own operator UI) claims its own files. A repo that is one package declares
// dir "" and claims everything nothing deeper does. The trailing separator is what keeps "_apps/webx/a.ts" out
// of "_apps/web".
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
    // What the header's glyph says: a real package manifest, or the fallback bucket for paths no module claims
    // (a repo's loose top-level files, a repo with no manifests at all). Naming those after the repo is honest
    // — they belong to no module — and it keeps every row of the list under exactly one header.
    readonly packaged: boolean;
    readonly rows: readonly T[];
}

// Rows grouped by module, in first-appearance order — which for a git-sorted list is path order, so the
// grouping never reshuffles a list the user has already learned to scan.
export const moduleGroups = <T>(
    rows: readonly T[],
    pathOf: (row: T) => string,
    modules: readonly WorkspaceModule[],
    fallbackName: string,
): readonly ModuleGroup<T>[] => {
    const grouped = new Map<string, { key: string; name: string; packaged: boolean; rows: T[] }>();
    for (const row of rows) {
        const found = moduleOf(pathOf(row), modules);
        // The fallback keys on a shape no module dir can take, so a repo-wide module (dir "") and the
        // unclaimed bucket can never collapse into one group.
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

// What a row shows once its module is named above it: the file, not the path to it. The path stays the
// tooltip — a basename is ambiguous by construction (two `index.ts` in one package), and this is the one
// reading where that ambiguity is not resolvable by looking.
export const rowName = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
