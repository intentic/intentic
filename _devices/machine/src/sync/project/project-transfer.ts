import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { claimPidFile, livePidRecord, releasePidFile } from "@intentic/local-agent";
import { type Pairing, pairingKey, pairingRemoteDir, projectDirection, type ProjectDirection } from "../config.js";
import {
    capped,
    type ChangeKind,
    classify,
    type FileStamp,
    ignoreExpressions,
    ignoreMatcher,
    type Listing,
    type ProjectChange,
    selectChanges,
} from "./project-files.js";
import {
    assertFolder,
    type Durability,
    hashFile,
    installFile,
    listingRecordPath,
    localFile,
    localTarget,
    readListingRecord,
    realDurability,
    removeFile,
    walkLocal,
    writeListingRecord,
} from "./project-local.js";
import type { Fetched, NotFetched, ReportedConflict, SandboxCopy, SessionControl } from "./project-remote.js";
import {
    backUp,
    createPointDir,
    listPoints,
    type PointSummary,
    pruneRestorePoints,
    readManifest,
    restoreDir,
    type RestoreEntry,
    restoreEntry,
    sealPoint,
    type Skipped,
    writeManifest,
} from "../restore-points.js";
import { ignoresFor } from "../ssh.js";

// BRINGING A COPY-FIRST PROJECT'S CHANGES BACK, and undoing that. The sandbox's copy is listed against this device's
// (project-files.ts says what counts as the sandbox's change, and what may never be written over), a restore point is
// kept of everything about to be overwritten or deleted here and flushed to the disk, and only then is anything written,
// with the project's Mutagen session paused throughout.
//
// WHY THE SESSION DOES NOT PUSH STALE CONTENT BACK afterwards (measured against Mutagen 0.18.1, README):
// - Nothing is written while it runs. Paused, it runs no cycle between the listing, the fetch and the writes, and on
//   resume it scans both sides afresh against the last state they agreed on.
// - What is written here is byte for byte what the sandbox holds (its sha256 checked against the listing), so on resume
//   both sides have moved from their last agreement to the same content: Mutagen records the new agreement and carries
//   nothing. A file is put in place by renaming a new file over it, so no scan cache can take it for the old one.
// - A sandbox file that changed again after it was fetched is a change on the sandbox's side one-way-safe must keep: it
//   is left as it is and reported as a conflict, never overwritten with this device's copy.
// - A file deleted here because the sandbox deleted it is a deletion on both sides, which is agreement too.

export type ProjectPairing = Pairing & { readonly localDir: string };

export interface ProjectContext extends FolderContext {
    readonly sandbox: SandboxCopy;
    // How a restore point is flushed to the disk; the real flush unless a test watches the order.
    readonly durability?: Durability;
}

// What holding a folder still takes, for anything that writes into it (a bring-back, a restore, a delivery of landed
// work, project-delivery.ts): the folder's pairing, the agent's own state dir (~/.intentic/machine), where restore
// points, the listing record and the lock live, keyed by the pairing's key, and its Mutagen session.
export interface FolderContext {
    readonly pairing: ProjectPairing;
    readonly stateDir: string;
    readonly session: SessionControl;
}

// One entry of `sync changes` as printed: a held change is a conflict, which bring-back lists but never writes over.
export interface ListedChange {
    readonly path: string;
    readonly kind: ChangeKind;
    readonly size?: number;
    readonly conflict?: true;
}

export interface ChangesResult {
    readonly ok: true;
    readonly pairing: string;
    readonly direction: ProjectDirection;
    readonly changes: readonly ListedChange[];
    readonly truncated?: true;
}

export interface Applied {
    readonly path: string;
    readonly kind: ChangeKind;
}

export interface BringBackResult {
    readonly ok: true;
    // The restore point that undoes it. One that brought nothing back names a point holding nothing, kept only until
    // the next bring-back and never listed (restore-points.ts retention).
    readonly point: string;
    readonly applied: readonly Applied[];
    readonly skipped: readonly Skipped[];
}

export interface RestorePointsResult {
    readonly ok: true;
    readonly points: readonly PointSummary[];
}

export interface RestoreResult {
    readonly ok: true;
    readonly restored: number;
    readonly skipped: readonly Skipped[];
}

// Where the session stood when a listing was taken: `current` only when it was running and a flush had just finished a
// whole cycle, and the file conflicts Mutagen then reported.
export interface Standing {
    readonly current: boolean;
    readonly conflicts: ReadonlyMap<string, ReportedConflict>;
}

const STALE: Standing = { current: false, conflicts: new Map() };

// A running session, flushed, so this device's latest edits are in the sandbox wherever the sandbox takes them.
const flushedStanding = async (context: FolderContext): Promise<Standing> => {
    const flushed = await context.session.flush();
    const after = await context.session.inspect();
    return { current: flushed && after.state === "running", conflicts: after.conflicts };
};

// A file's content here now as Mutagen hashes it, or undefined where it cannot be read (or is no longer a plain file).
const mutagenDigestHere = async (root: string, path: string): Promise<string | undefined> => {
    try {
        return await hashFile(await localTarget(root, path), "sha1");
    } catch {
        // allow(silent-catch): a file this device cannot read now is no evidence that it did not move, which is the answer.
        return undefined;
    }
};

// Mutagen's word, for each file it reported in conflict, on whether this device's copy is still what the two last
// agreed on: its own digests say it did not move, and the file here now is that same content.
const unchangedHere = async (root: string, conflicts: ReadonlyMap<string, ReportedConflict>, local: Listing): Promise<Map<string, boolean>> => {
    const verdicts = new Map<string, boolean>();
    for (const [path, reported] of conflicts) {
        const here = local.get(path);
        if (here === undefined || here === "other") {
            continue;
        }
        const unmoved = reported.agreed !== undefined && reported.agreed === reported.here;
        // oxlint-disable-next-line eslint/no-await-in-loop -- ten files at most (Mutagen reports no more)
        verdicts.set(path, unmoved && (await mutagenDigestHere(root, path)) === reported.here);
    }
    return verdicts;
};

interface Sides {
    readonly remote: Listing;
    readonly changes: readonly ProjectChange[];
}

// Both copies listed and told apart. This device's walk reads a file's content where the sandbox's size says nothing
// (the same size there) and wherever the record has the path, which is what tells an edit here from the sandbox's. The
// record is written back only by whoever holds the folder's lock (`record`), so a listing never undoes what a bring-back
// running beside it recorded.
const listSides = async (context: ProjectContext, standing: Standing, record: boolean): Promise<Sides> => {
    const { pairing, stateDir } = context;
    const patterns = ignoresFor(pairing);
    const remoteDir = pairingRemoteDir(pairing);
    const remote = await context.sandbox.list(ignoreExpressions(patterns));
    const recordPath = listingRecordPath(stateDir, pairingKey(pairing));
    const held = await readListingRecord(recordPath, pairing.localDir, remoteDir);
    const wantsHash = (path: string, size: number): boolean => {
        const there = remote.get(path);
        return held.agreed.has(path) || (there !== undefined && there !== "other" && there.size === size);
    };
    const local = await walkLocal({ root: pairing.localDir, ignored: ignoreMatcher(patterns), cached: held.files, wantsHash });
    const evidence = { current: standing.current, unchangedHere: await unchangedHere(pairing.localDir, standing.conflicts, local.listing) };
    const classified = classify(local.listing, remote, held.agreed, evidence);
    if (record) {
        await writeListingRecord(recordPath, pairing.localDir, remoteDir, { files: local.hashes, agreed: classified.agreed });
    }
    return { remote, changes: classified.changes };
};

// The two copies now agree on what was brought back, which the next listing must know before either side moves again:
// an edit made here afterwards is this device's, not the sandbox's to bring back over it.
const recordAgreement = async (context: ProjectContext, applied: readonly { readonly path: string; readonly hash: string | null }[]): Promise<void> => {
    const { pairing, stateDir } = context;
    const recordPath = listingRecordPath(stateDir, pairingKey(pairing));
    const record = await readListingRecord(recordPath, pairing.localDir, pairingRemoteDir(pairing));
    const agreed = new Map(record.agreed);
    for (const { path, hash } of applied) {
        if (hash === null) {
            agreed.delete(path);
        } else {
            agreed.set(path, hash);
        }
    }
    await writeListingRecord(recordPath, pairing.localDir, pairingRemoteDir(pairing), { files: record.files, agreed });
};

// The folder's own place under the state dir, where its lock, its pause marker and its restore points live.
export const folderStateDir = (context: Pick<FolderContext, "pairing" | "stateDir">): string => restoreDir(context.stateDir, pairingKey(context.pairing));

const lockPath = (context: Pick<FolderContext, "pairing" | "stateDir">): string => join(folderStateDir(context), ".operation.pid");

// Written just before an operation pauses the session and removed once it has resumed it: left behind, it is a pause
// nobody will lift, since the watcher resumes only the pauses it made itself.
const pausedPath = (context: Pick<FolderContext, "pairing" | "stateDir">): string => join(folderStateDir(context), ".paused");

// A pause an operation made and never lifted (it was killed between the two) is lifted by the next command about this
// folder, once no operation that could still lift it is running.
const liftAbandonedPause = async (context: FolderContext, locked: boolean): Promise<void> => {
    if (!existsSync(pausedPath(context)) || (!locked && (await livePidRecord(lockPath(context))) !== undefined)) {
        return;
    }
    await context.session.resume();
    await rm(pausedPath(context), { force: true });
};

export interface Held {
    readonly standing: Standing;
    // What lets the session go again; undefined where it was not this operation's to hold.
    readonly release: (() => Promise<void>) | undefined;
}

// The session held still for an operation, when it is running (one paused by somebody stays theirs), and what undoes
// that. With `flush`, a cycle first carries this device's latest edits over, and says whether it finished.
const holdStill = async (context: FolderContext, flush: boolean): Promise<Held> => {
    if ((await context.session.inspect()).state !== "running") {
        return { standing: STALE, release: undefined };
    }
    const standing = flush ? await flushedStanding(context) : STALE;
    await writeFile(pausedPath(context), `${process.pid}\n`, { mode: 0o600 });
    try {
        await context.session.pause();
    } catch (error) {
        await rm(pausedPath(context), { force: true });
        throw error;
    }
    const release = async (): Promise<void> => {
        await context.session.resume();
        await rm(pausedPath(context), { force: true });
    };
    return { standing, release };
};

const claim = async (context: Pick<FolderContext, "pairing" | "stateDir">): Promise<{ readonly claimed: boolean; readonly holder?: number }> => {
    const dir = folderStateDir(context);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const claimed = await claimPidFile(lockPath(context), dir, { pid: process.pid });
    return claimed.claimed ? { claimed: true } : { claimed: false, holder: claimed.holder.pid };
};

// One bring-back, restore or delivery per folder at a time, across processes (the desktop app, a terminal and the
// resident agent alike). A holder that died is no holder: the lock names a pid of this boot, checked alive.
export const exclusively = async <T>(context: FolderContext, operation: () => Promise<T>): Promise<T> => {
    const claimed = await claim(context);
    if (!claimed.claimed) {
        throw new Error(`another bring-back, restore or delivery for ${context.pairing.localDir} is running (pid ${claimed.holder}); try again once it has finished`);
    }
    try {
        await liftAbandonedPause(context, true);
        return await operation();
    } finally {
        await releasePidFile(lockPath(context), process.pid);
    }
};

// Runs an operation with the session held still, and says so plainly if it could not be let go again: the work is
// done and kept, but the folder has stopped syncing until something resumes it.
export const whileHeld = async <T>(context: FolderContext, flush: boolean, operation: (standing: Standing) => Promise<T>, done: (result: T) => string): Promise<T> => {
    const held = await holdStill(context, flush);
    let result: T;
    try {
        result = await operation(held.standing);
    } catch (error) {
        // allow(silent-catch): the operation's own failure is the one to report; the marker left behind lifts the pause later.
        await held.release?.().catch(() => undefined);
        throw error;
    }
    try {
        await held.release?.();
    } catch (error) {
        throw new Error(
            `${done(result)}, but this folder's file sync could not be resumed (${errorMessage(error)}). The next bring-back, restore or change listing resumes it, and so does \`intentic-machine sync resume --sandbox ${context.pairing.sandboxId}\`.`,
            { cause: error },
        );
    }
    return result;
};

const listed = (change: ProjectChange): ListedChange => {
    const { held, ...entry } = change;
    return held === undefined ? entry : { ...entry, conflict: true };
};

// SYNC CHANGES. Lists without the lock when a bring-back or restore holds it, and then leaves the record to that one.
export const projectChanges = async (context: ProjectContext): Promise<ChangesResult> => {
    const { claimed } = await claim(context);
    try {
        await liftAbandonedPause(context, claimed);
        const running = (await context.session.inspect()).state === "running";
        const standing = running ? await flushedStanding(context) : STALE;
        const shown = capped((await listSides(context, standing, claimed)).changes);
        const result: ChangesResult = { ok: true, pairing: pairingKey(context.pairing), direction: projectDirection(context.pairing), changes: shown.changes.map(listed) };
        return shown.truncated ? { ...result, truncated: true } : result;
    } finally {
        if (claimed) {
            await releasePidFile(lockPath(context), process.pid);
        }
    }
};

// A change that can be written here now: a deletion, or a file that arrived exactly as the sandbox's listing had it.
interface Ready {
    readonly change: ProjectChange;
    readonly fetched?: Fetched;
    // What bring-back leaves at the path: the sandbox's sha256, or null where it deletes the file.
    readonly applied: string | null;
}

const readiness = (change: ProjectChange, there: FileStamp | "other" | undefined, got: Fetched | NotFetched | undefined): Ready | NotFetched => {
    if (change.kind === "deleted") {
        return { change, applied: null };
    }
    if (got === undefined || "skipped" in got) {
        return got ?? { skipped: "the sandbox did not send it" };
    }
    if (there === undefined || there === "other" || there.hash !== got.hash || there.size !== got.size) {
        return { skipped: "it changed in the sandbox after it was listed; bring it back again" };
    }
    return { change, fetched: got, applied: got.hash };
};

// One change written here, only where the folder still holds what the restore point kept of it (or nothing, for a file
// being added): an edit made here meanwhile is the owner's, and is left alone and reported.
const apply = async (root: string, ready: Ready, entry: RestoreEntry): Promise<void> => {
    const current = await localFile(root, ready.change.path);
    if ((current?.hash ?? null) !== (entry.backedUp ? entry.backup : null)) {
        throw new Error("it changed here while it was being brought back");
    }
    if (ready.fetched === undefined) {
        await removeFile(root, ready.change.path);
        return;
    }
    const mode = current === undefined ? { executable: ready.fetched.executable } : { exact: current.mode };
    await installFile(root, ready.change.path, ready.fetched.staged, mode);
};

// Staging folders a killed bring-back or delivery left: only ever this pairing's, and only removed while holding its lock.
export const clearStaging = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).filter((entry) => entry.startsWith(".staging-"))) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- rarely more than one
        await rm(join(dir, name), { recursive: true, force: true });
    }
};

// The selected changes that may be written here, each fetched and checked; everything else is skipped with its reason.
const readyChanges = async (context: ProjectContext, sides: Sides, selected: readonly ProjectChange[], staging: string, skipped: Skipped[]): Promise<Ready[]> => {
    const writable = selected.filter((change) => {
        if (change.held !== undefined) {
            skipped.push({ path: change.path, reason: change.held });
        }
        return change.held === undefined;
    });
    const fetched = await context.sandbox.fetch(
        writable.filter((change) => change.kind !== "deleted").map((change) => change.path),
        staging,
    );
    const ready: Ready[] = [];
    for (const change of writable) {
        const verdict = readiness(change, sides.remote.get(change.path), fetched.get(change.path));
        if ("skipped" in verdict) {
            skipped.push({ path: change.path, reason: verdict.skipped });
        } else {
            ready.push(verdict);
        }
    }
    return ready;
};

const bringBackHeld = async (context: ProjectContext, paths: readonly string[], standing: Standing, staging: string): Promise<BringBackResult> => {
    const { pairing, stateDir } = context;
    const durability = context.durability ?? realDurability;
    const sides = await listSides(context, standing, true);
    const { selected, unmatched } = selectChanges(sides.changes, paths);
    const skipped: Skipped[] = unmatched.map((path) => ({ path, reason: "the sandbox's copy has no change to bring back there" }));
    const ready = await readyChanges(context, sides, selected, staging, skipped);
    // THE RESTORE POINT, before anything here is touched: each file about to be overwritten or deleted copied into it,
    // and all of it on the disk (sealPoint) before the first write.
    const key = pairingKey(pairing);
    const point = await createPointDir(stateDir, key, Date.now());
    const kept: { readonly ready: Ready; readonly entry: RestoreEntry }[] = [];
    for (const item of ready) {
        try {
            const request = { path: item.change.path, kind: item.change.kind, applied: item.applied };
            // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time, so a failure names one path
            kept.push({ ready: item, entry: await backUp(stateDir, key, point.id, pairing.localDir, request, durability) });
        } catch (error) {
            skipped.push({ path: item.change.path, reason: errorMessage(error) });
        }
    }
    const manifest = { id: point.id, createdAt: point.createdAt, dir: pairing.localDir, entries: kept.map(({ entry }) => entry) };
    await writeManifest(stateDir, key, manifest);
    await sealPoint(stateDir, key, point.id, durability);
    const done: { readonly entry: RestoreEntry; readonly kind: ChangeKind }[] = [];
    for (const { ready: item, entry } of kept) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await apply(pairing.localDir, item, entry);
            done.push({ entry, kind: item.change.kind });
        } catch (error) {
            skipped.push({ path: item.change.path, reason: errorMessage(error) });
        }
    }
    // What a restore can undo is what happened: the point is cut to the entries that were written.
    await writeManifest(stateDir, key, { ...manifest, entries: done.map(({ entry }) => entry) });
    await recordAgreement(
        context,
        done.map(({ entry }) => ({ path: entry.path, hash: entry.applied })),
    );
    return { ok: true, point: point.id, applied: done.map(({ entry, kind }) => ({ path: entry.path, kind })), skipped };
};

// BRING-BACK: the sandbox's changes (all, or those under `paths`) written into this folder, a restore point first. A
// conflict (a change held by project-files.ts) is skipped with its reason whether or not it was asked for.
export const bringBack = async (context: ProjectContext, paths: readonly string[]): Promise<BringBackResult> =>
    await exclusively(context, async () => {
        const dir = folderStateDir(context);
        await clearStaging(dir);
        const result = await whileHeld(
            context,
            true,
            async (standing) => {
                const staging = await mkdtemp(join(dir, ".staging-"));
                try {
                    return await bringBackHeld(context, paths, standing, staging);
                } finally {
                    await rm(staging, { recursive: true, force: true });
                }
            },
            (done) => `Brought back ${done.applied.length} file(s), restore point ${done.point}`,
        );
        await pruneRestorePoints(context.stateDir, pairingKey(context.pairing), Date.now(), result.point);
        return result;
    });

// Every restore point of this folder that holds something, newest first. Reads this device only.
export const restorePoints = async (context: Pick<ProjectContext, "pairing" | "stateDir">): Promise<RestorePointsResult> => ({
    ok: true,
    points: await listPoints(context.stateDir, pairingKey(context.pairing), context.pairing.localDir),
});

// RESTORE: a point's files put back and the files its bring-back added taken away, each only where the folder still
// holds exactly what that bring-back left. Copy-first then carries the result to the sandbox, as it does any edit here.
export const restorePoint = async (context: ProjectContext, id: string): Promise<RestoreResult> =>
    await exclusively(context, async () => {
        const { pairing, stateDir } = context;
        const key = pairingKey(pairing);
        const manifest = await readManifest(stateDir, key, id, pairing.localDir);
        await assertFolder(pairing.localDir);
        return await whileHeld(
            context,
            false,
            async () => {
                const skipped: Skipped[] = [];
                let restored = 0;
                for (const entry of manifest.entries) {
                    try {
                        // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time, so a failure names one path
                        await restoreEntry(stateDir, key, id, pairing.localDir, entry);
                        restored += 1;
                    } catch (error) {
                        skipped.push({ path: entry.path, reason: errorMessage(error) });
                    }
                }
                return { ok: true as const, restored, skipped };
            },
            (done) => `Restored ${done.restored} file(s) from ${id}`,
        );
    });
