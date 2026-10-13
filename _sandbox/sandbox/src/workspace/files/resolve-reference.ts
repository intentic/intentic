import { MAX_REF_CANDIDATES, rankRefCandidates, referenceTails, type WorkspaceResolve } from "@intentic/sandbox-contract";

// Resolves a named reference (a path written in prose) to a real workspace file: since it's often only a suffix of the
// true path, the reference is tried as written, then progressively shorter tails, first match wins. When nothing
// matches, that is the answer, with the files it may have meant beside it, rather than a path left to fail as if
// deleted. The copy it resolves in arrives as a ReferenceView, so the ordering is testable without a workspace or index.

/** One copy of the workspace as a resolver sees it: a conversation's checkout over the shared tree, or the shared tree. */
export interface ReferenceView {
    // Whether a workspace-relative path names a real file in this copy; a `../` escape never counts as one.
    readonly exists: (relPath: string) => boolean;
    // Files whose path is `tail` or ends in `/tail`, unranked, at most `limit`.
    readonly endingWith: (tail: string, limit: number) => Promise<readonly string[]>;
    // Files directly inside a folder whose path is `folder` or ends in `/folder`, unranked, at most `limit`.
    readonly inFolder: (folder: string, limit: number) => Promise<readonly string[]>;
    // Where this copy moved the files it renamed, old path to new; empty for the shared tree.
    readonly renamed: ReadonlyMap<string, string>;
}

// How much of a folder, or of one name's namesakes, is read looking for what a reference may have meant. Past this a
// folder is a dump, not a neighbourhood, and the list a reader is offered is capped far below it anyway.
const NEARBY_SCAN = 500;

// Leading folders dropped, at most, when finding the folder a reference named: the same allowance its file gets.
const MAX_FOLDER_DROPS = 6;

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const folderOf = (path: string): string => path.slice(0, Math.max(0, path.lastIndexOf(`/`)));
const endsWithPath = (path: string, tail: string): boolean => path === tail || path.endsWith(`/${tail}`);

// The name before its last extension and the extension, lower-cased; a dotfile is all stem.
const splitName = (name: string): { readonly stem: string; readonly ext: string } => {
    const dot = name.lastIndexOf(`.`);
    const lower = name.toLowerCase();
    return dot <= 0 ? { stem: lower, ext: `` } : { stem: lower.slice(0, dot), ext: lower.slice(dot + 1) };
};

// A short stem (`a`, `ui`) is contained in too many names to say anything.
const MIN_STEM = 3;

// Whether `candidate` reads as `wanted` renamed: same kind of file, one name holding the other. `config.toml` and
// `bib-config.toml`, `intentic-os.conf` and `intentic.conf`.
const renamedLike = (candidate: string, wanted: string): boolean => {
    const have = splitName(candidate);
    const want = splitName(wanted);
    if (have.ext !== want.ext || have.stem === want.stem || Math.min(have.stem.length, want.stem.length) < MIN_STEM) {
        return false;
    }
    return have.stem.includes(want.stem) || want.stem.includes(have.stem);
};

// How many of the folders a reference named a candidate also sits under: the measure of "close to where it was". A
// file moved to a sibling folder keeps its parents (`os-image/installer/` to `os-image/x/` keeps `os-image`).
const sharedFolders = (reference: string, candidate: string): number => {
    const around = new Set(folderOf(candidate).split(`/`));
    return folderOf(reference)
        .split(`/`)
        .filter((segment) => segment !== `` && around.has(segment)).length;
};

// Closest to where the reference pointed first, then shallowest, then shortest: one order however the copy listed them.
const byCloseness = (reference: string, paths: readonly string[]): string[] =>
    paths.toSorted(
        (a, b) =>
            sharedFolders(reference, b) - sharedFolders(reference, a) ||
            a.split(`/`).length - b.split(`/`).length ||
            a.length - b.length ||
            (a < b ? -1 : 1),
    );

// The folder a reference named, as written and then with leading folders dropped, most specific first; never down to
// nothing, since "any folder" is no neighbourhood.
const folderTails = (reference: string): readonly string[] => {
    const segments = folderOf(reference)
        .split(`/`)
        .filter((segment) => segment !== `` && segment !== `.`);
    const tails: string[] = [];
    for (let drop = 0; drop <= MAX_FOLDER_DROPS && drop < segments.length; drop++) {
        tails.push(segments.slice(drop).join(`/`));
    }
    return tails;
};

// What a reference nothing matched may have meant, most likely first. Renamed in place: a file in the folder it named,
// in the most specific form of that folder that still exists, whose name reads as the old one renamed. Moved: the same
// name anywhere else, closest to where it was.
const nearbyOf = async (reference: string, view: ReferenceView): Promise<string[]> => {
    const name = nameOf(reference);
    let renamedInPlace: string[] = [];
    for (const folder of folderTails(reference)) {
        const files = await view.inFolder(folder, NEARBY_SCAN);
        if (files.length > 0) {
            renamedInPlace = byCloseness(
                reference,
                files.filter((file) => renamedLike(nameOf(file), name)),
            );
            break;
        }
    }
    const moved = byCloseness(reference, await view.endingWith(name, NEARBY_SCAN));
    return [...new Set([...renamedInPlace, ...moved])].slice(0, MAX_REF_CANDIDATES);
};

// The rename a tail names: the conversation moved a file whose old path ends that way.
const renameEndingWith = (view: ReferenceView, tail: string): WorkspaceResolve | undefined => {
    for (const [from, to] of view.renamed) {
        if (endsWithPath(from, tail)) {
            return { path: to, renamedFrom: from };
        }
    }
    return undefined;
};

export const resolveReference = async (reference: string, root: string, view: ReferenceView): Promise<WorkspaceResolve> => {
    const tails = referenceTails(reference, root);
    // The reference as written: only this branch sees paths the search index ignores.
    const literal = tails[0];
    if (literal === undefined) {
        return {};
    }
    // Before existence: the shared tree still holds the name this copy moved its file away from, and showing that
    // stale namesake is how a renamed file reads as the wrong one.
    const moved = view.renamed.get(literal);
    if (moved !== undefined) {
        return { path: moved, renamedFrom: literal };
    }
    if (view.exists(literal)) {
        return { path: literal };
    }
    for (const tail of tails) {
        // A tail can match several files; shared ranking puts the shallowest first, usually the one meant, and the rest
        // ride along so the reader can switch rather than be handed one silently.
        const [best, ...others] = rankRefCandidates(tail, await view.endingWith(tail, NEARBY_SCAN));
        if (best !== undefined) {
            return others.length === 0 ? { path: best } : { path: best, others };
        }
        const renamed = renameEndingWith(view, tail);
        if (renamed !== undefined) {
            return renamed;
        }
    }
    const nearby = await nearbyOf(literal, view);
    return nearby.length === 0 ? {} : { nearby };
};
