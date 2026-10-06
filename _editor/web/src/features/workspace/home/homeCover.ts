import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract";
import { parentDir } from "@intentic/ui/path";
import { opensAsFolder } from "../files/archiveEntries";
import { byNaturalName } from "./homeOrder";

// The cover: one file name read in every folder (README.md, package.json). The explorer tree lists folders alone and
// marks the ones holding it, and the home shows the current folder's copy in place of its tiles, so a reader walks the
// tree reading that file at each stop. This decides which file in a folder answers for the name, which names are worth
// offering, and where below a folder the loaded tree knows of one. Pure, no framework code.

// What a document is written in, best first; "" is a bare name. README.md, README.rst and a bare README say the same
// thing in different notations, so a document's name matches its stem in any of these.
const DOCUMENT_EXTENSIONS: readonly string[] = [`md`, `markdown`, `mdx`, `rst`, `adoc`, `asciidoc`, `org`, `txt`, ``];

const stemAndExtension = (name: string): { readonly stem: string; readonly extension: string } => {
    const lower = name.toLowerCase();
    const dot = lower.lastIndexOf(`.`);
    return dot > 0 ? { stem: lower.slice(0, dot), extension: lower.slice(dot + 1) } : { stem: lower, extension: `` };
};

// A bare name is a document only when it is capitalised whole (README, LICENSE, CHANGELOG): Dockerfile and Makefile are
// bare too, and a Dockerfile.md beside a missing Dockerfile is a note about one, not one.
const isDocumentName = (name: string): boolean => {
    const { extension } = stemAndExtension(name);
    if (extension === ``) {
        return name === name.toUpperCase() && name !== name.toLowerCase();
    }
    return DOCUMENT_EXTENSIONS.includes(extension);
};

// How well a file answers for the cover `name`: lower is better, undefined not at all. The exact spelling, then any
// capitalisation, then (for a document) the same stem in another notation, in DOCUMENT_EXTENSIONS order.
export const coverRank = (file: string, name: string): number | undefined => {
    if (file === name) {
        return 0;
    }
    if (file.toLowerCase() === name.toLowerCase()) {
        return 1;
    }
    if (!isDocumentName(name)) {
        return undefined;
    }
    const { stem, extension } = stemAndExtension(file);
    if (stem !== stemAndExtension(name).stem) {
        return undefined;
    }
    const at = DOCUMENT_EXTENSIONS.indexOf(extension);
    return at === -1 ? undefined : 2 + at;
};

// A file a cover can be: a link that goes nowhere has nothing to read, and a folder is never one.
const readable = (entry: WorkspaceTreeEntry): boolean => entry.type === `file` && entry.link?.state === undefined;

// The file in one folder's listing that answers for `name`, best rank first and name order between equals.
export const coverIn = (listing: readonly WorkspaceTreeEntry[], name: string): WorkspaceTreeEntry | undefined => {
    let best: { readonly entry: WorkspaceTreeEntry; readonly rank: number } | undefined;
    for (const entry of listing) {
        const rank = readable(entry) ? coverRank(entry.name, name) : undefined;
        if (rank === undefined) {
            continue;
        }
        if (best === undefined || rank < best.rank || (rank === best.rank && byNaturalName(entry, best.entry) < 0)) {
            best = { entry, rank };
        }
    }
    return best?.entry;
};

// A name worth offering, and how many folders the loaded tree holds it in.
export interface CoverChoice {
    readonly name: string;
    readonly folders: number;
}

// One name as the chooser counts it: a document by its stem, so README.md and README.rst add up to one row.
const choiceKey = (name: string): string => (isDocumentName(name) ? `document:${stemAndExtension(name).stem}` : name.toLowerCase());

// The spelling a group of names is offered under: the one most folders use, the natural first between equals.
const commonest = (spellings: ReadonlyMap<string, number>): string => {
    let chosen = ``;
    let most = 0;
    for (const [spelling, count] of spellings) {
        if (count > most || (count === most && spelling.localeCompare(chosen) < 0)) {
            chosen = spelling;
            most = count;
        }
    }
    return chosen;
};

// A name held in one folder only has nothing to compare it with; the chooser is for names that repeat.
const MIN_FOLDERS = 2;

/**
 * The file names worth covering folders with: the ones that recur across folders, most folders first.
 *
 * @param files Every file to count, already narrowed to what the reader can see.
 * @param limit How many names to return.
 */
export const coverChoices = (files: Iterable<WorkspaceTreeEntry>, limit: number): readonly CoverChoice[] => {
    const groups = new Map<string, { readonly folders: Set<string>; readonly spellings: Map<string, number> }>();
    for (const file of files) {
        // An empty file (a .gitkeep holding a folder open) recurs everywhere and has nothing to read.
        if (!readable(file) || opensAsFolder(file) || file.size === 0) {
            continue;
        }
        const key = choiceKey(file.name);
        const group = groups.get(key) ?? { folders: new Set<string>(), spellings: new Map<string, number>() };
        groups.set(key, group);
        group.folders.add(parentDir(file.path));
        group.spellings.set(file.name, (group.spellings.get(file.name) ?? 0) + 1);
    }
    return [...groups.values()]
        .filter((group) => group.folders.size >= MIN_FOLDERS)
        .map((group) => ({ name: commonest(group.spellings), folders: group.folders.size }))
        .toSorted((left, right) => right.folders - left.folders || left.name.localeCompare(right.name))
        .slice(0, limit);
};

// Where the loaded tree knows of a cover: which folders hold one, and how many folders below each one do.
export interface CoverIndex {
    readonly held: ReadonlySet<string>;
    // Strictly below: a folder's own cover is `held`, not counted here.
    readonly below: ReadonlyMap<string, number>;
}

// No cover chosen, or nothing loaded yet: no folder holds one.
export const NO_COVERS: CoverIndex = { held: new Set(), below: new Map() };

/**
 * Where covers are, over everything loaded: it knows only what the eager walk and the lazy listings have seen, so every
 * answer is a lower bound.
 *
 * @param keep Whether a folder holding one counts: the caller's say on folders a reader cannot reach.
 */
export const coverIndex = (files: Iterable<WorkspaceTreeEntry>, name: string, keep: (folder: string) => boolean = () => true): CoverIndex => {
    const held = new Set<string>();
    for (const file of files) {
        if (readable(file) && coverRank(file.name, name) !== undefined && keep(parentDir(file.path))) {
            held.add(parentDir(file.path));
        }
    }
    const below = new Map<string, number>();
    for (const folder of held) {
        let at = folder;
        while (at !== ``) {
            at = parentDir(at);
            below.set(at, (below.get(at) ?? 0) + 1);
        }
    }
    return { held, below };
};

const depthOf = (path: string): number => (path === `` ? 0 : path.split(`/`).length);

// The folders below `dir` that hold a cover, nearest first: where a reader standing in a folder without one goes next.
export const coversBelow = (index: CoverIndex, dir: string, limit: number): readonly string[] => {
    const prefix = dir === `` ? `` : `${dir}/`;
    return [...index.held]
        .filter((folder) => folder !== dir && folder.startsWith(prefix))
        .toSorted((left, right) => depthOf(left) - depthOf(right) || left.localeCompare(right))
        .slice(0, limit);
};
