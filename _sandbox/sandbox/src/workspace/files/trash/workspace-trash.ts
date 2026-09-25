import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";

// The file view's trash: a delete moves the entry here instead of erasing it, so Undo can put it back. One folder per
// delete holds the entry itself and where it came from. A rename is instant for a folder of any size; the trash sits
// on the workspace's own volume so that it almost always is one.

// Longer than any undo stack lives in a browser tab, short enough that a deleted multi-gigabyte drop frees its space
// the same day.
export const TRASH_RETENTION_MS = 24 * 60 * 60 * 1000;

const ENTRY = "entry";
const ORIGIN = "origin.json";
// Ids are minted here; anything else is refused before it can name a path outside the trash.
const ID_PATTERN = /^[a-z0-9]+-[a-f0-9]{8}$/;

interface Origin {
    // Workspace-relative, as the delete named it; a restore resolves it again under the caller's own fence.
    readonly path: string;
}

const codeOf = (failure: unknown): string | undefined => (failure as NodeJS.ErrnoException | undefined)?.code;

// A rename, or a copy and erase when the two paths sit on different volumes (a mounted repo, say).
const relocate = async (from: string, to: string): Promise<void> => {
    try {
        await rename(from, to);
    } catch (failure) {
        if (codeOf(failure) !== "EXDEV") {
            throw failure;
        }
        await cp(from, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
        await rm(from, { recursive: true, force: true });
    }
};

const exists = async (path: string): Promise<boolean> =>
    lstat(path).then(
        () => true,
        () => false,
    );

// The first of `name (restored)`, `name (restored 2)`, … nothing holds; a file keeps its extension last.
export const freeRestoreTarget = async (abs: string, isDir: boolean): Promise<string> => {
    if (!(await exists(abs))) {
        return abs;
    }
    const name = basename(abs);
    const ext = isDir || name.startsWith(".") ? "" : extname(name);
    const stem = name.slice(0, name.length - ext.length);
    for (let n = 1; ; n += 1) {
        const candidate = join(dirname(abs), `${stem} (restored${n === 1 ? "" : ` ${n}`})${ext}`);
        if (!(await exists(candidate))) {
            return candidate;
        }
    }
};

export class TrashMissError extends Error {}

export interface WorkspaceTrash {
    // Moves `abs` into the trash and answers its id, or undefined when nothing was there to move.
    readonly put: (abs: string, relPath: string) => Promise<string | undefined>;
    // Puts the entry back where `resolve` says its recorded path lives now, answering where it landed. TrashMissError
    // when the id names nothing: expired, restored already, or never minted.
    readonly restore: (id: string, resolve: (relPath: string) => Promise<string>) => Promise<string>;
    // Drops every delete older than the retention.
    readonly sweep: (now: number) => Promise<void>;
}

export const createWorkspaceTrash = (trashDir: string): WorkspaceTrash => {
    const put = async (abs: string, relPath: string): Promise<string | undefined> => {
        if (!(await exists(abs))) {
            return undefined;
        }
        // The trash itself, or a folder holding it, can't move into itself: that one is erased for good.
        if (abs === trashDir || trashDir.startsWith(`${abs}${sep}`)) {
            await rm(abs, { recursive: true, force: true });
            return undefined;
        }
        const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
        const slot = join(trashDir, id);
        await mkdir(slot, { recursive: true });
        try {
            await writeFile(join(slot, ORIGIN), JSON.stringify({ path: relPath } satisfies Origin));
            await relocate(abs, join(slot, ENTRY));
        } catch (failure) {
            await rm(slot, { recursive: true, force: true });
            // Gone between the check and the move: someone else deleted it, which is the outcome asked for.
            if (codeOf(failure) === "ENOENT" && !(await exists(abs))) {
                return undefined;
            }
            throw failure;
        }
        return id;
    };

    const restore = async (id: string, resolve: (relPath: string) => Promise<string>): Promise<string> => {
        if (!ID_PATTERN.test(id)) {
            throw new TrashMissError(`no trashed entry "${id}"`);
        }
        const slot = join(trashDir, id);
        const origin = await readFile(join(slot, ORIGIN), "utf8").then(
            (text) => JSON.parse(text) as Origin,
            () => undefined,
        );
        const held = join(slot, ENTRY);
        const entry = await lstat(held).catch(undefinedIfMissing);
        if (origin === undefined || entry === undefined) {
            throw new TrashMissError(`no trashed entry "${id}"`);
        }
        const target = await freeRestoreTarget(await resolve(origin.path), entry.isDirectory());
        await mkdir(dirname(target), { recursive: true });
        await relocate(held, target);
        await rm(slot, { recursive: true, force: true });
        return target;
    };

    const sweep = async (now: number): Promise<void> => {
        const ids = (await readdir(trashDir).catch(undefinedIfMissing)) ?? [];
        await Promise.all(
            ids.map(async (id) => {
                const slot = join(trashDir, id);
                const stats = await stat(slot).catch(undefinedIfMissing);
                if (stats !== undefined && now - stats.mtimeMs > TRASH_RETENTION_MS) {
                    // allow(silent-catch): a slot that cannot be removed now is swept again on the next pass.
                    await rm(slot, { recursive: true, force: true }).catch(() => undefined);
                }
            }),
        );
    };

    return { put, restore, sweep };
};
