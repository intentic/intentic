import type { WorkspaceSearchHit, WorkspaceSearchSpan } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { isLockedWorkspacePath } from "@intentic/sandbox-contract/state/workspace-state";
import { scannerPruneGlobs } from "@intentic/workspace-ignore";
import type { Ripgrep } from "./ripgrep.js";
import { type Cut, type Found, MAX_PER_FILE, MAX_TEXT_BYTES, byMatches, groupOf, hitOf } from "./search-hits.js";
import type { Pattern } from "./search-read.js";

// A folder's search run by ripgrep (ripgrep.ts), over the files the explorer lists: the folder's own .gitignore files
// honoured whether or not it is a repository, nothing above the folder read, the ignored folders (node_modules, build
// output) and a version history pruned unless asked for, dotfiles in. What the file API refuses (isLockedWorkspacePath)
// is dropped from what comes back. Patterns are rg's, as the sandbox's search reads them, and rg runs in time linear
// in the text, so no pattern needs refusing here.

export interface RgScope {
    // The subtree to look in, as segments below the root; empty for the whole folder.
    readonly dir: readonly string[];
    readonly includeIgnored: boolean;
    // Whether a found file is one the caller wants: an `include` pattern, a name.
    readonly wanted: (path: string) => boolean;
    readonly budgetMs: number;
    readonly signal?: AbortSignal | undefined;
}

// The walk every run makes, matching the explorer's (walk.ts): see above.
const walkArgs = (scope: RgScope): string[] => {
    const args = [
        `--no-config`,
        `--hidden`,
        `--no-ignore-parent`,
        `--no-ignore-global`,
        `--no-ignore-exclude`,
        `--no-require-git`,
        `--no-messages`,
        `--path-separator`,
        `/`,
    ];
    if (scope.includeIgnored) {
        args.push(`--no-ignore`);
    }
    for (const glob of scannerPruneGlobs(scope.includeIgnored)) {
        args.push(`-g`, glob);
    }
    // A subtree is narrowed to after the walk (keptPath): naming it as rg's path would drop the ignore files above it,
    // and a glob naming it would let in what they ignore, since rg's globs outrank every ignore file.
    return args;
};

// A path as rg prints it (`./a/b`), as the contract speaks it (`a/b`). On Windows rg's JSON names a file with
// backslashes whatever `--path-separator` says (that switch reaches only its plain output, measured 2026-10-17 with rg
// 15.2.0), and no Windows file name can hold one, so every backslash there is a separator.
export const printedPath = (printed: string, platform: NodeJS.Platform = process.platform): string =>
    (platform === `win32` ? printed.replaceAll(`\\`, `/`) : printed).replace(/^\.\//, ``);

// That path, when the caller may have it.
const keptPath = (printed: string, scope: RgScope): string | undefined => {
    const path = printedPath(printed);
    const dir = scope.dir.join(`/`);
    const inDir = dir === `` || path.startsWith(`${dir}/`);
    return inDir && !isLockedWorkspacePath(path) && scope.wanted(path) ? path : undefined;
};

// A run's stop: its clock, the time it was given counted from now, or the caller letting go of the answer.
interface Clock {
    readonly signal: AbortSignal;
    // Whether it was the clock that stopped the run.
    readonly late: () => boolean;
}

const clockFor = (scope: RgScope): Clock => {
    const timer = AbortSignal.timeout(scope.budgetMs);
    return { signal: scope.signal === undefined ? timer : AbortSignal.any([timer, scope.signal]), late: () => timer.aborted };
};

export interface Listed {
    // Root-relative, forward slashes, in path order.
    readonly paths: readonly string[];
    readonly cut?: Cut | undefined;
}

// Every file the explorer would list under the scope, up to `maxFiles`; undefined when no rg could run.
export const filesByRg = async (rg: Ripgrep, root: string, scope: RgScope, maxFiles: number): Promise<Listed | undefined> => {
    const paths: string[] = [];
    let cut: Cut | undefined;
    const clock = clockFor(scope);
    const exit = await rg(
        root,
        [...walkArgs(scope), `--files`, `--`, `./`],
        (line) => {
            const path = keptPath(line, scope);
            if (path !== undefined) {
                paths.push(path);
            }
            if (paths.length > maxFiles) {
                cut = `files`;
                return false;
            }
            return true;
        },
        clock.signal,
    );
    if (exit === undefined) {
        return undefined;
    }
    cut ??= clock.late() ? `time` : undefined;
    // rg walks in parallel, so its order is the run's own; sorted, two runs list one folder alike.
    return { paths: paths.slice(0, maxFiles).toSorted(), cut };
};

interface RgText {
    readonly text?: string;
}
interface RgEvent {
    readonly type: string;
    readonly data: {
        readonly path?: RgText;
        readonly line_number?: number;
        readonly lines?: RgText;
        readonly submatches?: readonly { readonly start: number; readonly end: number }[];
    };
}

// UTF-8 byte width of one code point.
const utf8Width = (code: number): number => (code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x1_0000 ? 3 : 4);

// rg's spans count bytes of the line; the page slices characters. One forward walk converts every offset.
export const charSpans = (text: string, spans: readonly WorkspaceSearchSpan[]): WorkspaceSearchSpan[] => {
    const wanted = [...new Set(spans.flatMap((span) => [span.start, span.end]))].toSorted((a, b) => a - b);
    const chars = new Map<number, number>();
    let byte = 0;
    let index = 0;
    let next = 0;
    while (next < wanted.length) {
        while (next < wanted.length && (wanted[next] ?? 0) <= byte) {
            chars.set(wanted[next] ?? 0, index);
            next += 1;
        }
        if (index >= text.length) {
            break;
        }
        const code = text.codePointAt(index) ?? 0;
        byte += utf8Width(code);
        index += code < 0x1_0000 ? 1 : 2;
    }
    // Anything the walk never reached points past the line, clamped to its end.
    return spans.map((span) => ({ start: chars.get(span.start) ?? text.length, end: chars.get(span.end) ?? text.length }));
};

// Whether rg refuses the pattern itself (look-around, a backreference, a typo), told by its exit code rather than by its
// words: asked of nothing (its stdin, closed at once), a pattern it reads matches nothing and exits 1, and one it cannot
// read exits 2 before reading anything.
const refusesPattern = async (rg: Ripgrep, root: string, pattern: Pattern): Promise<boolean> => {
    const args = [`--no-config`];
    if (pattern.literal === true) {
        args.push(`-F`);
    }
    if (pattern.word === true) {
        args.push(`-w`);
    }
    args.push(`-e`, pattern.query, `-`);
    return (await rg(root, args, () => true))?.code === 2;
};

export type RgFound = Found & { readonly unreadPattern?: true };

// Every file's matching lines under the scope, until the files, `maxHits` or the clock run out; undefined when no rg
// could run. A pattern rg cannot read answers `unreadPattern` with nothing found, for the caller to ask as plain text.
export const findByRg = async (rg: Ripgrep, root: string, pattern: Pattern, scope: RgScope, maxHits: number): Promise<RgFound | undefined> => {
    const args = [...walkArgs(scope), `--json`, `--max-count`, String(MAX_PER_FILE + 1), `--max-filesize`, String(MAX_TEXT_BYTES)];
    if (pattern.literal === true) {
        args.push(`-F`);
    }
    if (pattern.word === true) {
        args.push(`-w`);
    }
    // Any case unless asked, never rg's smart case, where a capital would narrow the search unasked.
    args.push(pattern.caseSensitive === true ? `-s` : `-i`, `-e`, pattern.query, `--`, `./`);

    const files = new Map<string, { hits: WorkspaceSearchHit[]; capped: boolean }>();
    let current: { hits: WorkspaceSearchHit[]; capped: boolean } | undefined;
    let hits = 0;
    let cut: Cut | undefined;
    const clock = clockFor(scope);
    const onEvent = (event: RgEvent): boolean => {
        if (event.type === `begin`) {
            const path = event.data.path?.text === undefined ? undefined : keptPath(event.data.path.text, scope);
            current = path === undefined ? undefined : { hits: [], capped: false };
            if (path !== undefined && current !== undefined) {
                files.set(path, current);
            }
            return true;
        }
        if (event.type !== `match` || current === undefined) {
            return true;
        }
        // The cap+1st line is read only to learn there are more than the file keeps.
        if (current.hits.length === MAX_PER_FILE) {
            current.capped = true;
            return true;
        }
        const text = event.data.lines?.text?.replace(/\r?\n$/, ``);
        if (text === undefined) {
            return true;
        }
        const spans = charSpans(text, event.data.submatches ?? []).filter((span) => span.end > span.start);
        current.hits.push(hitOf(event.data.line_number ?? 0, text, spans));
        hits += 1;
        if (hits >= maxHits) {
            cut = `matches`;
            return false;
        }
        return true;
    };
    const exit = await rg(
        root,
        args,
        (line) => {
            try {
                // SAFETY: rg --json prints one event object per line; every field read off it is optional above.
                return onEvent(JSON.parse(line) as RgEvent);
            } catch {
                // allow(silent-catch): a line that is not one of rg's events (a warning on stdout) carries no match.
                return true;
            }
        },
        clock.signal,
    );
    if (exit === undefined) {
        return undefined;
    }
    // A run that failed having found nothing: the pattern, or the folder (one that cannot be read) answering nothing.
    if (exit.code === 2 && files.size === 0 && (await refusesPattern(rg, root, pattern))) {
        return { groups: [], unreadPattern: true };
    }
    cut ??= clock.late() ? `time` : undefined;
    const groups = [...files].flatMap(([path, file]) => groupOf(path, file.hits, file.capped) ?? []);
    return { groups: groups.toSorted(byMatches), cut };
};
