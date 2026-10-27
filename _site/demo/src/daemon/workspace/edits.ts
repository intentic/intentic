import { refuse } from "@intentic/contract-serve";
import type { WorkspaceChildren, WorkspaceTree, WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { archiveFormat, archiveStem, wrapsItsOwnName } from "@intentic/sandbox-contract/text/archives";
import { archiveMembers, deleteEntry, workspaceChildren, workspaceEntries, workspaceTree } from "../../fixture/workspace";
import { forgetBytes, moveBytes, copyBytes } from "./bytes";
import { pushPaths } from "./workspaceBroadcast";

// The tree's own edits, as the daemon's file routes make them: a new folder, a move or rename, a copy, an archive
// unpacked beside itself. The flat file table (fixture/workspace.ts) holds files only, so a folder made empty is kept
// here and folded into every listing, the way a real directory stays on disk with nothing in it.

const FOLDERS = new Set<string>();

const parentOf = (path: string): string => (path.includes(`/`) ? path.slice(0, path.lastIndexOf(`/`)) : ``);
const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const clean = (path: string): string => path.replaceAll(/^\/+|\/+$/gu, ``);
const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** Whether anything, file or folder, sits at `path` now. */
export const exists = (path: string): boolean =>
    path === `` || [...workspaceEntries().keys()].some((file) => under(file, path)) || [...FOLDERS].some((folder) => under(folder, path));

/** Whether a file (not a folder) sits at `path`. */
const isFile = (path: string): boolean => workspaceEntries().has(path);

// A write through a path's parents makes them real, as `mkdir -p` and a write's own parent creation do; an empty folder
// that now holds something no longer needs keeping here.
const settleParents = (path: string): void => {
    for (let parent = parentOf(path); parent !== ``; parent = parentOf(parent)) {
        FOLDERS.delete(parent);
    }
};

/** POST /workspace/dir: the folder and any missing above it. */
export const makeFolder = (path: string): void => {
    const dir = clean(path);
    if (isFile(dir)) {
        refuse(`"${dir}" is a file`, 409);
    }
    if (!exists(dir)) {
        settleParents(dir);
        FOLDERS.add(dir);
    }
    pushPaths([dir]);
};

// What lives under `from`, file by file and empty folder by folder, so a move or copy carries the whole branch.
const branchOf = (from: string) => ({
    files: [...workspaceEntries()].filter(([path]) => under(path, from)),
    folders: [...FOLDERS].filter((folder) => under(folder, from)),
});

const retarget = (path: string, from: string, to: string): string => to + path.slice(from.length);

// The same refusals the daemon's move and copy make before touching anything.
const checkPair = (from: string, to: string): void => {
    if (from === to) {
        refuse(`"${from}" is already there`, 400);
    }
    if (under(to, from)) {
        refuse(`a folder cannot go inside itself`, 400);
    }
    if (exists(to)) {
        refuse(`"${to}" already exists`, 409);
    }
};

/** POST /workspace/move: one entry to a new path, which is also a rename. */
export const moveEntry = (source: string, target: string): void => {
    const [from, to] = [clean(source), clean(target)];
    const { files, folders } = branchOf(from);
    if (files.length === 0 && folders.length === 0) {
        refuse(`"${from}" is not there`, 404);
    }
    checkPair(from, to);
    const table = workspaceEntries();
    for (const [path, entry] of files) {
        table.delete(path);
        table.set(retarget(path, from, to), entry);
        moveBytes(path, retarget(path, from, to));
    }
    for (const folder of folders) {
        FOLDERS.delete(folder);
        FOLDERS.add(retarget(folder, from, to));
    }
    settleParents(to);
    pushPaths([from, to]);
};

// Inside a dropped archive, its members are read-only but can be copied out: the one source a copy may take that the
// table holds no row for.
const archiveBranch = (from: string): [string, string | number][] => {
    const archive = [...workspaceEntries().keys()].find((path) => from.startsWith(`${path}/`) && archiveMembers(path) !== undefined);
    if (archive === undefined) {
        return [];
    }
    const inside = from.slice(archive.length + 1);
    return (archiveMembers(archive) ?? [])
        .filter(([member]) => under(member, inside))
        .map(([member, entry]) => [`${archive}/${member}`, entry]);
};

/** POST /workspace/copy: one entry duplicated at a new path, a folder with everything in it. */
export const copyEntry = (source: string, target: string): void => {
    const [from, to] = [clean(source), clean(target)];
    const own = branchOf(from);
    const files = own.files.length > 0 ? own.files : archiveBranch(from);
    if (files.length === 0 && own.folders.length === 0) {
        refuse(`"${from}" is not there`, 404);
    }
    checkPair(from, to);
    const table = workspaceEntries();
    for (const [path, entry] of files) {
        table.set(retarget(path, from, to), entry);
        copyBytes(path, retarget(path, from, to));
    }
    for (const folder of own.folders) {
        FOLDERS.add(retarget(folder, from, to));
    }
    settleParents(to);
    pushPaths([to]);
};

/** DELETE /workspace/entry: the fixture's trash takes the files; an empty folder simply goes. */
export const deleteAny = (path: string): { ok: true; trashed?: string } => {
    const target = clean(path);
    for (const folder of [...FOLDERS].filter((candidate) => under(candidate, target))) {
        FOLDERS.delete(folder);
    }
    const answer = deleteEntry(target);
    // A folder the delete emptied stays a folder; the daemon removes the entry, not its parent.
    const parent = parentOf(target);
    if (parent !== `` && !exists(parent)) {
        FOLDERS.add(parent);
    }
    forgetBytes(target);
    pushPaths([target]);
    return answer;
};

// The first of `base`, `base 2`, `base 3`… nothing holds yet: the daemon's own free-name rule.
const freeName = (base: string): string => {
    for (let index = 1; ; index += 1) {
        const candidate = index === 1 ? base : `${base} ${index}`;
        if (!exists(candidate)) {
            return candidate;
        }
    }
};

// `site.zip` holding a single `site/` lands as one folder, not two: its members are lifted out of that root.
const unwrapped = (members: readonly [string, string | number][], stem: string): [string, string | number][] => {
    const roots = new Set(members.map(([member]) => member.split(`/`)[0] ?? ``));
    const [sole] = roots;
    if (roots.size !== 1 || sole === undefined || !wrapsItsOwnName(sole, stem) || !members.every(([member]) => member.includes(`/`))) {
        return [...members];
    }
    return members.map(([member, entry]) => [member.slice(sole.length + 1), entry]);
};

/** POST /workspace/extract: what the archive holds, unpacked into a new folder beside it; answers where it landed. */
export const extractArchive = (path: string) => {
    const archive = clean(path);
    const name = nameOf(archive);
    const stem = archiveStem(name);
    if (archiveFormat(name) === undefined || stem === undefined) {
        refuse(`nothing here unpacks ${name}`, 400);
    }
    if (!isFile(archive)) {
        refuse(`"${archive}" is not there`, 404);
    }
    const members = archiveMembers(archive) ?? [[`${stem}.txt`, `The archive ${name} as it was dropped: one file, unpacked.\n`]];
    const parent = parentOf(archive);
    const landed = freeName(parent === `` ? (stem ?? name) : `${parent}/${stem ?? name}`);
    const table = workspaceEntries();
    for (const [member, entry] of unwrapped(members, stem ?? name)) {
        table.set(`${landed}/${member}`, entry);
    }
    settleParents(`${landed}/x`);
    pushPaths([landed]);
    return { path: landed };
};

/** A file the upload routes wrote: its parents are real now. */
export const noteWritten = (paths: readonly string[]): void => {
    for (const path of paths) {
        settleParents(path);
        FOLDERS.delete(path);
    }
    pushPaths(paths);
};

// The kept empty folders as tree entries, nested under the folders the walk already built.
const dirEntry = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `dir`, children: [] });

const graft = (entries: readonly WorkspaceTreeEntry[], folder: string, prefix = ``): WorkspaceTreeEntry[] => {
    const rest = prefix === `` ? folder : folder.slice(prefix.length + 1);
    const head = rest.split(`/`)[0] ?? rest;
    const path = prefix === `` ? head : `${prefix}/${head}`;
    const found = entries.find((entry) => entry.path === path);
    if (path === folder) {
        return found === undefined ? [...entries, dirEntry(folder)] : [...entries];
    }
    const node = found ?? dirEntry(path);
    const grafted: WorkspaceTreeEntry = { ...node, children: graft(node.children ?? [], folder, path) };
    return found === undefined ? [...entries, grafted] : entries.map((entry) => (entry === found ? grafted : entry));
};

// Directories first, then by name, as the daemon's walk returns them.
const ordered = (entries: readonly WorkspaceTreeEntry[]): WorkspaceTreeEntry[] =>
    entries
        .map((entry) => (entry.children === undefined ? entry : { ...entry, children: ordered(entry.children) }))
        .toSorted((left, right) => (left.type === right.type ? left.name.localeCompare(right.name) : left.type === `dir` ? -1 : 1));

/** GET /workspace/tree: the fixture's walk with the kept empty folders folded in. */
export const editedTree = (): WorkspaceTree => {
    const walked = workspaceTree();
    if (FOLDERS.size === 0) {
        return walked;
    }
    const tree = [...FOLDERS].toSorted().reduce<WorkspaceTreeEntry[]>((entries, folder) => graft(entries, folder), [...walked.tree]);
    return { ...walked, tree: ordered(tree) };
};

/** GET /workspace/children: one folder's entries, its kept empty folders among them. */
export const editedChildren = (path: string): WorkspaceChildren => {
    const listed = workspaceChildren(path);
    const prefix = `${clean(path)}/`;
    const names = new Set(listed.entries.map((entry) => entry.name));
    const extra = [...FOLDERS].flatMap((folder) => {
        if (!folder.startsWith(prefix)) {
            return [];
        }
        const name = folder.slice(prefix.length).split(`/`)[0] ?? ``;
        if (names.has(name)) {
            return [];
        }
        names.add(name);
        return [{ name, path: `${prefix}${name}`, type: `dir` as const }];
    });
    return extra.length === 0 ? listed : { ...listed, entries: ordered([...listed.entries, ...extra]) };
};
