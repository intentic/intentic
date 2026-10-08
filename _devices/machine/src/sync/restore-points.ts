import { copyFile, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { writeFileAtomic } from "@intentic/base/fs";
import { z } from "zod";
import type { ChangeKind } from "./project/project-files.js";
import { type Durability, hashFile, installFile, localFile, localTarget, removeFile } from "./project/project-local.js";

// RESTORE POINTS: what `sync bring-back` keeps before it writes a byte into the owner's folder, one directory per bring-back
// under ~/.intentic/machine/restore/<pairing key>/ (config.ts `pairingKey`): `manifest.json`, and `files/<path>`, a copy
// of every file of the folder it is about to overwrite or delete. A file it adds is listed without one, so a restore takes
// it away again. A delivery of landed work (project-delivery.ts) keeps its points here too, in the same shape.

export const restoreDir = (stateDir: string, key: string): string => join(stateDir, "restore", encodeURIComponent(key));

// A point's id is its creation time in ISO 8601's basic format (20260928T213000.123Z): it sorts as it reads, and it is a
// folder name on every system, which the extended format's colons are not on Windows.
const POINT_ID = /^\d{8}T\d{6}\.\d{3}Z$/;

export const pointId = (at: Date): string => at.toISOString().replace(/[-:]/g, "");

export const pointTime = (id: string): number | undefined =>
    POINT_ID.test(id) ? Date.parse(`${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 11)}:${id.slice(11, 13)}:${id.slice(13)}`) : undefined;

// A manifest is read back by every later release, so its fields are only ever added. Beyond the three every entry
// carries (path, kind, backedUp): `applied`, the sha256 of what bring-back left at the path (null where it deleted the
// file), which is what a restore requires the folder to still hold; `backup`, the sha256 of `files/<path>`, checked
// before it is put back; and `mode`, the permission bits that file had. A point a delivery took also names the land it
// wrote (`landing`), which nothing reads back to decide anything.
const EntrySchema = z.object({
    path: z.string(),
    kind: z.enum(["added", "modified", "deleted"]),
    backedUp: z.boolean(),
    applied: z.string().nullable(),
    backup: z.string().optional(),
    mode: z.number().optional(),
});

const ManifestSchema = z.object({
    id: z.string(),
    createdAt: z.string(),
    dir: z.string(),
    entries: z.array(EntrySchema),
    landing: z.object({ agentId: z.string(), title: z.string().optional() }).optional(),
});

export type RestoreEntry = z.infer<typeof EntrySchema>;
export type Manifest = z.infer<typeof ManifestSchema>;

export interface Skipped {
    readonly path: string;
    readonly reason: string;
}

const manifestPath = (stateDir: string, key: string, id: string): string => join(restoreDir(stateDir, key), id, "manifest.json");

// Durable: on the disk, with the point folder's entry for it, before the write returns (sealPoint says why).
export const writeManifest = async (stateDir: string, key: string, manifest: Manifest): Promise<void> =>
    await writeFileAtomic(manifestPath(stateDir, key, manifest.id), `${JSON.stringify(manifest, undefined, 2)}\n`, 0o600, { durable: true });

// A manifest as this build reads it, or undefined for one it cannot: torn, or of a shape it has no word for.
const parsedManifest = (raw: string): Manifest | undefined => {
    try {
        return ManifestSchema.safeParse(JSON.parse(raw)).data;
    } catch {
        // allow(silent-catch): bytes that are not JSON are a manifest this build cannot read, said by the caller.
        return undefined;
    }
};

// The point with this id for this folder, or a sentence saying why there is none. A point of another folder (this sandbox
// paired with a different one before) is not this folder's to restore.
export const readManifest = async (stateDir: string, key: string, id: string, dir: string): Promise<Manifest> => {
    const raw = POINT_ID.test(id) ? await readFile(manifestPath(stateDir, key, id), "utf8").catch(undefinedIfMissing) : undefined;
    if (raw === undefined) {
        throw new Error(`there is no restore point ${JSON.stringify(id)} for ${dir}`);
    }
    const manifest = parsedManifest(raw);
    if (manifest === undefined) {
        throw new Error(`restore point ${id} was written by an agent this one cannot read`);
    }
    if (manifest.dir !== dir) {
        throw new Error(`restore point ${id} belongs to ${manifest.dir}, not ${dir}`);
    }
    return manifest;
};

export interface PointSummary {
    readonly id: string;
    readonly createdAt: string;
    readonly entries: number;
}

// Newest first, and only points that hold something: one whose manifest never got written (a bring-back cut off while
// backing up) promises nothing, and neither does one of a bring-back that wrote nothing.
export const listPoints = async (stateDir: string, key: string, dir: string): Promise<PointSummary[]> => {
    const names = (await readdir(restoreDir(stateDir, key)).catch(undefinedIfMissing)) ?? [];
    const points: PointSummary[] = [];
    for (const id of names.filter((name) => POINT_ID.test(name)).toSorted().toReversed()) {
        // allow(silent-catch): a point of another folder, or one this build cannot read, is not this folder's to offer.
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of small files, read in the order they are listed
        const manifest = await readManifest(stateDir, key, id, dir).catch(() => undefined);
        if (manifest !== undefined && manifest.entries.length > 0) {
            points.push({ id: manifest.id, createdAt: manifest.createdAt, entries: manifest.entries.length });
        }
    }
    return points;
};

// RETENTION: the newest 20 of a pairing's points that hold something, and every such point younger than 30 days,
// whatever their number. A point that holds nothing (a bring-back that wrote nothing, or one cut off before its
// manifest, which is written before anything in the folder changes) is never counted, and goes at the next bring-back;
// until then it is what that bring-back answered with.
export const RETAINED_NEWEST = 20;
export const RETAINED_MS = 30 * 24 * 60 * 60_000;

// What a point directory holds, as retention reads it. A manifest this build cannot read (a later release's) counts as
// holding something: it is aged out by the rules above, never cleared as empty.
export type PointHolding = "files" | "nothing" | "unfinished";

export interface PointOnDisk {
    readonly id: string;
    readonly holding: PointHolding;
}

// Which point directories go. `keep` is the point the bring-back running now answered with.
export const expiredPoints = (points: readonly PointOnDisk[], now: number, keep?: string): string[] => {
    const held = points.filter((point) => point.holding === "files" && POINT_ID.test(point.id)).toSorted((a, b) => b.id.localeCompare(a.id));
    const aged = held.filter((point, at) => at >= RETAINED_NEWEST && now - (pointTime(point.id) ?? now) >= RETAINED_MS);
    const empty = points.filter((point) => point.holding !== "files" && POINT_ID.test(point.id) && point.id !== keep);
    return [...aged, ...empty].map((point) => point.id).toSorted();
};

const holdingOf = async (stateDir: string, key: string, id: string): Promise<PointHolding> => {
    const raw = await readFile(manifestPath(stateDir, key, id), "utf8").catch(undefinedIfMissing);
    if (raw === undefined) {
        return "unfinished";
    }
    return parsedManifest(raw)?.entries.length === 0 ? "nothing" : "files";
};

// Run only by a bring-back, under its folder's lock: an unfinished point is then never one being written.
export const pruneRestorePoints = async (stateDir: string, key: string, now: number, keep?: string): Promise<void> => {
    const dir = restoreDir(stateDir, key);
    const names = ((await readdir(dir).catch(undefinedIfMissing)) ?? []).filter((name) => POINT_ID.test(name));
    const points: PointOnDisk[] = [];
    for (const id of names) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a handful of small files
        points.push({ id, holding: await holdingOf(stateDir, key, id) });
    }
    for (const id of expiredPoints(points, now, keep)) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- few, and one at a time keeps a failure to one point
        await rm(join(dir, id), { recursive: true, force: true });
    }
};

// A new point's directory, named for now; a second bring-back within the same millisecond takes the next one.
export const createPointDir = async (stateDir: string, key: string, now: number): Promise<{ readonly id: string; readonly createdAt: string }> => {
    await mkdir(restoreDir(stateDir, key), { recursive: true, mode: 0o700 });
    for (let at = now; ; at += 1) {
        const created = new Date(at);
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- tries the next millisecond only when this one is taken
            await mkdir(join(restoreDir(stateDir, key), pointId(created)), { mode: 0o700 });
            return { id: pointId(created), createdAt: created.toISOString() };
        } catch (error) {
            if (errnoCode(error) !== "EEXIST") {
                throw error;
            }
        }
    }
};

export interface BackupRequest {
    readonly path: string;
    readonly kind: ChangeKind;
    // The sha256 bring-back is about to leave at the path, null where it deletes the file.
    readonly applied: string | null;
}

// The entry for one change, its file copied into the point first where bring-back will overwrite or delete one. An
// added file must be absent here now: something that appeared under its name since the listing (or a file whose name
// differs only in case, on a disk that ignores case) is not bring-back's to replace.
export const backUp = async (stateDir: string, key: string, id: string, root: string, request: BackupRequest, durability: Durability): Promise<RestoreEntry> => {
    const current = await localFile(root, request.path);
    if (request.kind === "added") {
        if (current !== undefined) {
            throw new Error("a file appeared here under that name since the sandbox's copy was listed");
        }
        return { path: request.path, kind: request.kind, backedUp: false, applied: request.applied };
    }
    if (current === undefined) {
        throw new Error("it is no longer in this folder");
    }
    const copy = join(restoreDir(stateDir, key), id, "files", ...request.path.split("/"));
    await mkdir(dirname(copy), { recursive: true, mode: 0o700 });
    await copyFile(await localTarget(root, request.path), copy);
    await durability.file(copy);
    const backup = await hashFile(copy);
    if (backup !== current.hash) {
        throw new Error("it changed here while it was being backed up");
    }
    return { path: request.path, kind: request.kind, backedUp: true, applied: request.applied, backup, mode: current.mode };
};

// Every folder under `dir`, deepest first and `dir` last; none when it is not there (a point that backed nothing up).
const foldersIn = async (dir: string): Promise<string[]> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing);
    if (entries === undefined) {
        return [];
    }
    const nested = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => await foldersIn(join(dir, entry.name))));
    return [...nested.flat(), dir];
};

// THE POINT ON THE DISK before the folder it protects is touched: its copies were flushed as they were made and its
// manifest by its own durable write; what is left is every folder's entries, from the deepest copy up to the folder that
// lists the point. Without this, a crash just after a bring-back could leave the folder rewritten and the copies empty.
export const sealPoint = async (stateDir: string, key: string, id: string, durability: Durability): Promise<void> => {
    const dir = join(restoreDir(stateDir, key), id);
    for (const folder of [...(await foldersIn(join(dir, "files"))), dir, restoreDir(stateDir, key)]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- deepest first, so each folder is flushed after what it lists
        await durability.folder(folder);
    }
};

// ONE ENTRY PUT BACK, only where the folder still holds exactly what bring-back left there: a file somebody changed since
// is theirs now, and is reported instead.
export const restoreEntry = async (stateDir: string, key: string, id: string, root: string, entry: RestoreEntry): Promise<void> => {
    const current = await localFile(root, entry.path);
    const now = current?.hash ?? null;
    if (now !== entry.applied) {
        const before = entry.backedUp ? entry.backup : null;
        throw new Error(now === before ? "it is already as it was before that bring-back" : "it changed here since that bring-back");
    }
    if (!entry.backedUp) {
        await removeFile(root, entry.path);
        return;
    }
    const copy = join(restoreDir(stateDir, key), id, "files", ...entry.path.split("/"));
    const held = await hashFile(copy).catch(undefinedIfMissing);
    if (held === undefined || held !== entry.backup) {
        throw new Error("its copy in the restore point is missing or damaged");
    }
    await installFile(root, entry.path, copy, { exact: entry.mode ?? 0o644 });
};
