import type { WorkspaceModule } from "@intentic/sandbox-contract";

/* Reading a change list by MODULE rather than by path. A review's first question is "which parts of the system
 * did this touch", and a flat list of repo-relative paths answers it only by making the reader re-derive the
 * grouping from thirty repeated prefixes, in a sidebar where the prefix is also the half that truncates away.
 *
 * So the module becomes the HEADER and the file keeps the row. The inverse (a module name per row) was the
 * obvious reading of "show modules instead of paths" and is the wrong one: nine consecutive rows reading
 * "@intentic/desktop" say nothing about the thing you are about to click.
 *
 * THE WHOLE RULE LIVES HERE, not just its first half. There are two review lists, the workspace's Changes
 * panel and the fleet's agent review, and they had each written their own copy of "which buckets, and do they
 * get headings", which is how the two ended up disagreeing about the same change set. Now they call moduleView
 * and render what it says. (It sits in composables/ rather than under either panel for the same reason: shared
 * code filed inside one of its two consumers is shared code waiting to be forked.)
 *
 * WHOSE modules, though, is each surface's own business, and that distinction is the point: a list groups by
 * the package layout of the TREE ITS ROWS CAME FROM. The Changes panel reads /work (useModules); an agent's
 * review reads the layout its diff shipped with, because the agent's files live in a worktree /work cannot see
 *, a package it has just created exists nowhere else, and a new package's files are ALL changes. */

// The module a repo-relative path belongs to: the longest module dir that prefixes it, so a package nested
// inside another (an app with its own operator UI) claims its own files. A repo that is one package declares
// dir "" and claims everything nothing deeper does. The trailing separator is what keeps "_apps/webx/a.ts" out
// of "_editor/web".
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
    //, they belong to no module, and it keeps every row of the list under exactly one header.
    readonly packaged: boolean;
    readonly rows: readonly T[];
}

// Rows grouped by module, in first-appearance order, which for a git-sorted list is path order, so the
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

/* A LIST AS IT IS ACTUALLY DRAWN: the buckets, and whether they get headings. Both review panels compute this
 * once per change to their rows and read it from every header and every row, a grouping pass per row would be
 * quadratic on a landing the daemon is allowed to ship 500 rows a repo for.
 *
 * `named` is the judgement worth stating once: a LONE bucket of files no module claims would print the repo's
 * own name directly under the repo's own heading, which says nothing, so it draws no heading, and its rows
 * keep their full paths, because with nothing above them naming the package a bare filename is all the reader
 * would get. Everything else is headed. */
// Generic over the BUCKET rather than the row, so a panel that hangs its own numbers off each bucket (the agent
// review's per-package ± and blocker count) states its view type as ModuleView<ItsOwnBucket> instead of
// re-declaring the shape.
export interface ModuleView<B> {
    readonly buckets: readonly B[];
    readonly named: boolean;
}

export const moduleView = <T>(
    rows: readonly T[],
    pathOf: (row: T) => string,
    modules: readonly WorkspaceModule[],
    fallbackName: string,
    // The reader's preference (useChangeGrouping). Off ⇒ one unnamed bucket, i.e. the plain path list.
    grouped: boolean,
): ModuleView<ModuleGroup<T>> => {
    if (!grouped) {
        return { buckets: [{ key: `all`, name: ``, packaged: false, rows }], named: false };
    }
    const buckets = moduleGroups(rows, pathOf, modules, fallbackName);
    return { buckets, named: buckets.length > 1 || buckets[0]?.packaged === true };
};

// The view of a repo that has no rows at all, a shared constant so neither panel has to invent an empty one
// (and so an empty view is never accidentally `named`).
export const EMPTY_MODULE_VIEW: ModuleView<never> = { buckets: [], named: false };
