import { cp, mkdir, rename } from "node:fs/promises";
import hostPath, { dirname, join, type PlatformPath } from "node:path";
import { errnoCode, errorMessage } from "@intentic/base/errors";
import { type ProcedureHandler, refuse } from "@intentic/contract-serve";
import { STATE_DIR } from "@intentic/sandbox-contract";
import type { AskVerb } from "./control.js";
import { type Grant, ONE_DOCUMENT, READ_ONLY } from "./grants.js";
import { entryOf, type Resolved, resolveEntry, resolveWritable, segmentsOf, within } from "./paths.js";

// The explorer's four verbs over a folder window's tree, by the daemon's rules for /work
// (_sandbox/sandbox/src/workspace/workspace.routes.ts): a new folder is `mkdir -p`, a move or copy never lands on a name
// that is taken, and a copy keeps links as links. A delete is never permanent here: the app moves the entry to the
// system's Recycle Bin or Trash, where the user gets it back the way they get anything back, and when the app cannot,
// nothing is removed at all. A link is moved, copied or deleted as itself, never what it points at.

// Asks the app that started this process to do what only it may (asks.ts).
export type Ask = (verb: AskVerb, path: string) => Promise<void>;

const NOT_HERE = `That's the folder this window opened; it can't be changed from here.`;
const locked = (name: string): string => `“${name}” is kept by Git or Intentic, so it can't be changed here.`;
const taken = (name: string): string => `“${name}” already exists.`;
const missing = (name: string): string => `“${name}” isn't there.`;

// A version history and Intentic's own records, wherever they sit: moving or deleting either breaks what keeps it.
const LOCKED = new Set([`.git`, STATE_DIR]);

// The path's segments once this window may change what it names: a folder window's, below its root, outside what is
// locked. Refused otherwise, in words the explorer shows.
const changeable = (grant: Grant, path: string): readonly string[] => {
    if (grant.file !== undefined) {
        return refuse(ONE_DOCUMENT, 403);
    }
    if (grant.readOnly === true) {
        return refuse(READ_ONLY, 403);
    }
    const segments = segmentsOf(path);
    if (segments === undefined) {
        return refuse(`invalid path`, 400);
    }
    if (segments.length === 0) {
        return refuse(NOT_HERE, 403);
    }
    const lock = segments.find((segment) => LOCKED.has(segment));
    return lock === undefined ? segments : refuse(locked(lock), 403);
};

const nameOf = (segments: readonly string[]): string => segments.at(-1) ?? ``;

// Whether an entry moved or copied from `from` to `to` would land inside itself: the folder `to` goes in is `from` or
// below it. Asked of that folder, not of `to` itself, so a rename to another spelling of the entry's own name
// (`Report.docx` to `report.docx`, one path to Windows) is not taken for one.
export const intoItself = (from: string, to: string, rules: PlatformPath = hostPath): boolean => within(from, rules.dirname(to), rules);

// A resolved path's real place, or the refusal a route answers with.
const foundOr = (resolved: Resolved, name: string): string => {
    if (resolved.kind === `refused`) {
        return refuse(resolved.why, 400);
    }
    return resolved.kind === `missing` ? refuse(missing(name), 404) : resolved.abs;
};

// Where the disk refused a change, in the daemon's words for the same case, by the code it failed with. A race lands
// here too: something took the name, or took the entry away, between the look and the change.
const DENIED = { status: 403, error: () => `this computer does not let you change that` };
const BUSY = { status: 423, error: () => `another program has it open` };
const DISK_REFUSALS = new Map<string, { readonly status: number; readonly error: (name: string) => string }>([
    [`EACCES`, DENIED],
    // What Windows says of a file another program holds open (a document in Word), as files.ts reads it too.
    [`EPERM`, process.platform === `win32` ? BUSY : DENIED],
    [`EROFS`, DENIED],
    [`EBUSY`, BUSY],
    [`EEXIST`, { status: 409, error: taken }],
    [`ENOTEMPTY`, { status: 409, error: taken }],
    [`ERR_FS_CP_EEXIST`, { status: 409, error: taken }],
    [`ENOENT`, { status: 404, error: missing }],
    [`ENOTDIR`, { status: 400, error: () => `not a folder` }],
    [`EXDEV`, { status: 409, error: (name) => `“${name}” is on another drive than where it would go.` }],
]);

// Runs a change on disk, answering what the disk refused as that refusal; anything else is a failure to report.
const onDisk = async (name: string, change: () => Promise<void>): Promise<void> => {
    try {
        await change();
    } catch (error) {
        const refusal = DISK_REFUSALS.get(errnoCode(error) ?? ``);
        if (refusal === undefined) {
            throw error;
        }
        refuse(refusal.error(name), refusal.status);
    }
};

// Where an entry named by `to` goes: below the real path of the folder it goes in, which the move or copy makes when
// it is missing, and never where something already is. `moving`, the entry a move takes, may be there already under
// another spelling of its own name (`Report.docx` to `report.docx` on a disk that ignores case).
const placeFor = async (grant: Grant, to: readonly string[], moving?: string): Promise<string> => {
    const name = nameOf(to);
    const folder = to.length === 1 ? grant.root : foundOr(await resolveWritable(grant.root, to.slice(0, -1).join(`/`)), name);
    if ((await entryOf(folder))?.isDirectory() === false) {
        return refuse(`not a folder`, 400);
    }
    const abs = join(folder, name);
    const there = await entryOf(abs);
    if (there === undefined) {
        return abs;
    }
    const self = moving === undefined ? undefined : await entryOf(moving);
    return self !== undefined && self.dev === there.dev && self.ino === there.ino ? abs : refuse(taken(name), 409);
};

export const treeVerbsFor = (grant: Grant, ask: Ask) => {
    const move: ProcedureHandler<`workspace`, `move`> = async ({ from, to }) => {
        const source = changeable(grant, from);
        const target = changeable(grant, to);
        const fromAbs = foundOr(await resolveEntry(grant.root, from), nameOf(source));
        const toAbs = await placeFor(grant, target, fromAbs);
        if (intoItself(fromAbs, toAbs)) {
            return refuse(`“${nameOf(source)}” can't be moved into itself.`, 400);
        }
        await onDisk(nameOf(target), async () => {
            await mkdir(dirname(toAbs), { recursive: true });
            await rename(fromAbs, toAbs);
        });
        return { ok: true as const };
    };

    // Recursive for a folder, with every link inside copied as the link it is, and never over anything.
    const copy: ProcedureHandler<`workspace`, `copy`> = async ({ from, to }) => {
        const source = changeable(grant, from);
        const target = changeable(grant, to);
        const fromAbs = foundOr(await resolveEntry(grant.root, from), nameOf(source));
        const toAbs = await placeFor(grant, target);
        if (intoItself(fromAbs, toAbs)) {
            return refuse(`“${nameOf(source)}” can't be copied into itself.`, 400);
        }
        await onDisk(nameOf(target), async () => {
            await mkdir(dirname(toAbs), { recursive: true });
            await cp(fromAbs, toAbs, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
        });
        return { ok: true as const };
    };

    // `mkdir -p`: a folder already there is the answer, a file there is not.
    const makeDir: ProcedureHandler<`workspace`, `mkdir`> = async ({ path }) => {
        const segments = changeable(grant, path);
        const abs = foundOr(await resolveWritable(grant.root, path), nameOf(segments));
        const there = await entryOf(abs);
        if (there !== undefined && !there.isDirectory()) {
            return refuse(taken(nameOf(segments)), 409);
        }
        await onDisk(nameOf(segments), async () => {
            await mkdir(abs, { recursive: true });
        });
        return { ok: true as const };
    };

    // To the system's trash through the app, or not at all. Nothing there is already the answer, with no trash id: the
    // system's trash has none to give back.
    const remove: ProcedureHandler<`workspace`, `delete`> = async ({ path }) => {
        const segments = changeable(grant, path);
        const entry = await resolveEntry(grant.root, path);
        if (entry.kind === `missing`) {
            return { ok: true as const };
        }
        const abs = foundOr(entry, nameOf(segments));
        try {
            await ask(`trash`, abs);
        } catch (error) {
            return refuse(errorMessage(error), 503);
        }
        return { ok: true as const };
    };

    return { move, copy, mkdir: makeDir, delete: remove };
};
