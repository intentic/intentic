import { randomUUID } from "node:crypto";
import { sep } from "node:path";
import { rankByFuzzy } from "@intentic/base/fuzzy";
import { refuse } from "@intentic/contract-serve";
import { includeMatcher } from "@intentic/sandbox-contract/policy/search-globs";
import { referenceTails } from "@intentic/sandbox-contract/text/path-refs";
import type { WorkspaceSearchGroup, WorkspaceSearchResult } from "@intentic/sandbox-contract/schemas/workspace/workspace-search";
import { cleanRelPath, resolveExisting, segmentsOf } from "./paths.js";
import type { Ripgrep } from "./ripgrep.js";
import { type Cut, type Found, SEARCH_BOUNDS, type SearchBounds } from "./search-hits.js";
import { findHere, matcherOf, NOT_A_PATTERN } from "./search-read.js";
import { filesByRg, findByRg, type Listed, type RgScope } from "./search-rg.js";
import { sweep } from "./sweep.js";

export { SEARCH_BOUNDS, type SearchBounds } from "./search-hits.js";

// The explorer's search over a folder on the user's disk, answered in the daemon's shape (workspace-search.ts in the
// contract) without its index: every search reads the folder as it is now. `find` matches lines of text, `files`
// matches paths as quick-open does, and any other mode runs as `find`, since a folder has no index of symbols or
// meaning to ask. Ripgrep answers where this computer can run one (search-rg.ts), inside the folder's WSL distro when it
// lives in one (ripgrep.ts); otherwise the folder is read here (search-read.ts). What one search reads is bounded, and
// an answer cut by a bound says which, rather than reading as all.

export interface SearchQuery {
    readonly query: string;
    readonly mode?: string | undefined;
    readonly includeIgnored?: boolean | undefined;
    readonly dir?: string | undefined;
    readonly literal?: boolean | undefined;
    readonly word?: boolean | undefined;
    readonly caseSensitive?: boolean | undefined;
    readonly include?: string | undefined;
    readonly limit?: number | undefined;
    readonly after?: string | undefined;
}

export interface SearchOptions {
    readonly bounds?: SearchBounds | undefined;
    // Ripgrep, where this computer has one to run; without it the folder is read here.
    readonly rg?: Ripgrep | undefined;
    // The asker letting go of the answer (a newer keystroke): a run of rg still going is stopped.
    readonly signal?: AbortSignal | undefined;
}

// What a page carries per file and line, as the daemon's engine pages them (iq-engine).
const PAGE_FILES = 300;
const PAGE_HITS = 1_000;

// Why an answer stops short, by the bound that stopped it.
const CUT_NOTES = {
    files: () => `Stopped early: the folder is larger than one search reads. Narrow it to a folder or a file pattern.`,
    matches: (bounds) => `Stopped at the first ${bounds.hits.toLocaleString(`en`)} matching lines. Narrow the search to see the rest.`,
    time: (bounds) =>
        `Stopped after ${Math.round(bounds.budgetMs / 1000)} seconds: the folder is slow to read from here. Narrow it to a folder or a file pattern.`,
} satisfies Readonly<Record<Cut, (bounds: SearchBounds) => string>>;

// One search's whole answer, of which a page is a slice.
interface Answer {
    readonly mode: `find` | `files`;
    readonly found: Found;
    readonly note?: string | undefined;
}

// Answers kept for their later pages, so a page past the first is a slice of what the first page found rather than
// another search whose answer may have moved since. Few, and briefly: the editor asks for the next page when the
// reader scrolls to it, and a new search starts from its own first page.
const KEPT_ANSWERS = 8;
const KEPT_MS = 5 * 60_000;
const kept = new Map<string, { readonly root: string; readonly at: number; readonly answer: Answer }>();

const keep = (root: string, answer: Answer): string => {
    const id = randomUUID();
    kept.set(id, { root, at: Date.now(), answer });
    for (const [old, entry] of kept) {
        if (kept.size > KEPT_ANSWERS || Date.now() - entry.at > KEPT_MS) {
            kept.delete(old);
        }
    }
    return id;
};

// A cursor is `<answer>.<offset>`; a bare offset (an editor from before) or an answer no longer kept searches again.
const cursorOf = (after: string | undefined): { readonly id?: string; readonly offset: number } => {
    const [first = ``, second] = (after ?? `0`).split(`.`);
    const offset = Number(second ?? first);
    if (!Number.isInteger(offset) || offset < 0) {
        return refuse(`invalid cursor`, 400);
    }
    return second === undefined ? { offset } : { id: first, offset };
};

// The page `offset` asks for: whole groups, up to the page's file and line counts, and where the next page starts.
const pageOf = (groups: readonly WorkspaceSearchGroup[], offset: number, limit: number | undefined) => {
    const files = Math.min(limit ?? PAGE_FILES, PAGE_FILES);
    const page: WorkspaceSearchGroup[] = [];
    let shown = 0;
    for (const group of groups.slice(offset)) {
        if (page.length === files || (page.length > 0 && shown + group.hits.length > PAGE_HITS)) {
            break;
        }
        page.push(group);
        shown += group.hits.length;
    }
    const next = offset + page.length;
    return { page, shown, next: next < groups.length ? next : undefined };
};

// The subtree `dir` names, as the daemon reads it: `./` and trailing slashes dropped; undefined for one that leaves.
const dirOf = (dir: string | undefined): readonly string[] | undefined => segmentsOf((dir ?? ``).replace(/^\.\//, ``).replace(/\/+$/, ``));

// Whether a budget that starts now is spent, by the bounds' own clock.
const budget = (bounds: SearchBounds): (() => boolean) => {
    const deadline = bounds.now() + bounds.budgetMs;
    return () => bounds.now() > deadline;
};

// Every file a search may read under `dir`, by rg where it runs, else walked here.
const listed = async (root: string, scope: RgScope, bounds: SearchBounds, rg: Ripgrep | undefined): Promise<Listed> => {
    const byRg = rg === undefined ? undefined : await filesByRg(rg, root, scope, bounds.scanned);
    if (byRg !== undefined) {
        return byRg;
    }
    const swept = await sweep(root, { ...scope, maxFiles: bounds.scanned, over: budget(bounds) });
    return { paths: swept.files.map((file) => file.path), cut: swept.cut };
};

// Paths ranked as quick-open ranks them, the basename's own matches first (@intentic/base/fuzzy).
const filesMatching = (paths: readonly string[], query: string): WorkspaceSearchGroup[] =>
    rankByFuzzy(query, paths).map(({ path, score }) => {
        const rounded = Math.round(Math.min(1, score) * 100) / 100;
        return { path, score: rounded, hits: [{ line: 1, text: path, spans: [], tags: [{ kind: `fuzzy`, score: rounded }] }] };
    });

// The lines matching the query, by rg where it runs, else read here. A pattern rg cannot read is asked again as plain
// text, as the search here does with one it cannot (search-read.ts), and the answer says so either way.
const linesMatching = async (root: string, search: SearchQuery, scope: RgScope, bounds: SearchBounds, rg: Ripgrep | undefined): Promise<Answer> => {
    if (rg !== undefined) {
        const byRg = await findByRg(rg, root, search, scope, bounds.hits);
        if (byRg?.unreadPattern === true) {
            const plain = await findByRg(rg, root, { ...search, literal: true }, scope, bounds.hits);
            return { mode: `find`, found: plain ?? { groups: [] }, note: NOT_A_PATTERN };
        }
        if (byRg !== undefined) {
            return { mode: `find`, found: byRg };
        }
    }
    // A pattern the search here would backtrack on without end is refused before the folder is read (search-read.ts).
    const matcher = matcherOf(search);
    const over = budget(bounds);
    const swept = await sweep(root, { ...scope, maxFiles: bounds.scanned, over });
    const found = await findHere(swept.files, matcher.regex, bounds.hits, over);
    return { mode: `find`, found: { groups: found.groups, cut: swept.cut ?? found.cut }, note: matcher.note };
};

const answerTo = async (root: string, search: SearchQuery, options: SearchOptions): Promise<Answer> => {
    const bounds = options.bounds ?? SEARCH_BOUNDS;
    const mode = search.mode === `files` ? `files` : `find`;
    const dir = dirOf(search.dir);
    if (dir === undefined) {
        return { mode, found: { groups: [] } };
    }
    const scope: RgScope = {
        dir,
        includeIgnored: search.includeIgnored === true,
        wanted: includeMatcher(search.include),
        budgetMs: bounds.budgetMs,
        signal: options.signal,
    };
    if (mode === `find`) {
        return linesMatching(root, search, scope, bounds, options.rg);
    }
    const files = await listed(root, scope, bounds, options.rg);
    return { mode, found: { groups: filesMatching(files.paths, search.query), cut: files.cut } };
};

export const searchFolder = async (root: string, search: SearchQuery, options: SearchOptions = {}): Promise<WorkspaceSearchResult> => {
    const bounds = options.bounds ?? SEARCH_BOUNDS;
    const cursor = cursorOf(search.after);
    const held = cursor.id === undefined ? undefined : kept.get(cursor.id);
    const answer = held?.root === root ? held.answer : await answerTo(root, search, options);
    const id = held?.root === root && cursor.id !== undefined ? cursor.id : keep(root, answer);
    const { groups, cut } = answer.found;
    const { page, shown, next } = pageOf(groups, cursor.offset, search.limit);
    const result: WorkspaceSearchResult = {
        mode: answer.mode,
        total: answer.mode === `files` ? groups.length : groups.reduce((sum, group) => sum + group.hits.length, 0),
        files: groups.length,
        shown,
        groups: page,
        freshness: { state: `fresh` },
        truncated: next !== undefined || cut !== undefined,
    };
    if (cut !== undefined || groups.some((group) => group.capped === true)) {
        result.partial = true;
    }
    if (next !== undefined) {
        result.cursor = `${id}.${next}`;
    }
    const note = cut === undefined ? answer.note : CUT_NOTES[cut](bounds);
    if (note !== undefined) {
        result.note = note;
    }
    return result;
};

// Which file a written path means: the path itself when it is there, else the one file whose path ends the same way,
// the longest ending first. A path two files could end in resolves to nothing rather than to a guess, and so does one
// in a folder too large to walk within the bounds: a file found once in the part walked may have a twin past it.
export const resolveIn = async (root: string, reference: string, options: SearchOptions = {}): Promise<{ path?: string }> => {
    const bounds = options.bounds ?? SEARCH_BOUNDS;
    const tails = referenceTails(reference, root.split(sep).join(`/`));
    const literal = cleanRelPath(tails[0] ?? reference.replaceAll(`\\`, `/`));
    if (literal !== undefined && literal !== `` && (await resolveExisting(root, literal)).kind === `found`) {
        return { path: literal };
    }
    const name = literal?.split(`/`).at(-1);
    if (name === undefined || name === ``) {
        return {};
    }
    const scope: RgScope = { dir: [], includeIgnored: false, wanted: (path) => path.endsWith(name), budgetMs: bounds.budgetMs, signal: options.signal };
    const files = await listed(root, scope, bounds, options.rg);
    if (files.cut !== undefined) {
        return {};
    }
    const named = files.paths.filter((path) => path === name || path.endsWith(`/${name}`));
    for (const tail of [...tails, name]) {
        const [only, ...others] = named.filter((path) => path === tail || path.endsWith(`/${tail}`));
        if (only !== undefined) {
            return others.length === 0 ? { path: only } : {};
        }
    }
    return {};
};
