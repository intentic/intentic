import { rankByFuzzy } from "@intentic/base/fuzzy";
import type { WorkspaceSearchGroup } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { globToRegExp } from "./glob.js";
import { admitterOf, normalized, runRg, targetsOf, walkArgs, type WalkScope } from "./walk.js";

// A search box's name search: every file the walk admits (the same walk as text search, walk.ts), ranked against the
// query by the scorer the editor's own quick-open ranks with (@intentic/base/fuzzy), so a file comes first the same way
// whichever side answered. The editor asks for it only when its copy of the tree cannot answer: ignored files wanted,
// or a tree too large to send whole.

// Paths listed before the listing stops: past this a tree is a dump, and a name search over it is answered from what
// came first. node_modules across a monorepo runs to a few hundred thousand files.
export const FILES_MAX_LISTED = 500_000;

// A query holding one of these is a glob, matched as a pattern rather than ranked by letters.
const GLOB_CHARS = /[*?[]/u;

export interface FileSearchOptions extends WalkScope {
    readonly query: string;
    // Best matches returned; the rest are only counted.
    readonly limit: number;
}

export interface FileFind {
    // Best first, at most `limit` of them, each a file with no lines.
    readonly groups: readonly WorkspaceSearchGroup[];
    // Every file the query matched, shown or not.
    readonly files: number;
    // The listing stopped at FILES_MAX_LISTED, so a match past it was never seen.
    readonly ceiling: boolean;
}

// Every admitted file under the scope, root-relative, in the order rg found them, and whether the listing was cut short.
const listFiles = async (options: WalkScope): Promise<{ readonly paths: readonly string[]; readonly ceiling: boolean }> => {
    const prefixes = options.paths?.map(normalized);
    const targets = await targetsOf(options, prefixes);
    if (targets.paths.length === 0) {
        return { paths: [], ceiling: false };
    }
    const admits = admitterOf(options, prefixes);
    const paths: string[] = [];
    const run = await runRg(options.rgPath ?? "rg", options.root, ["--files", ...walkArgs(options), ...targets.args, "--", ...targets.paths], options.signal, (line) => {
        const path = normalized(line);
        if (admits(path)) {
            paths.push(path);
        }
        return paths.length < FILES_MAX_LISTED;
    });
    // 2 is a file or folder rg could not read, the rest listed; only a listing that found nothing at all is a failure.
    if (!run.stopped && run.code === 2 && paths.length === 0) {
        throw new Error(`ripgrep could not list the files: ${run.stderr.trim()}`);
    }
    return { paths, ceiling: run.stopped };
};

// Files whose path matches the query: a glob as a pattern (in path order), anything else by fuzzy score, best first.
export const findFiles = async (options: FileSearchOptions): Promise<FileFind> => {
    const listed = await listFiles(options);
    const query = options.query.trim();
    const glob = GLOB_CHARS.test(query) ? globToRegExp(query) : undefined;
    const ranked =
        glob === undefined
            ? rankByFuzzy(query, listed.paths)
            : listed.paths
                  .filter((path) => glob.test(path))
                  .toSorted()
                  .map((path) => ({ path, score: 1 }));
    return {
        groups: ranked.slice(0, options.limit).map(({ path, score }) => ({ path, score, hits: [] })),
        files: ranked.length,
        ceiling: listed.ceiling,
    };
};
