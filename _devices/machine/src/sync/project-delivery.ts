import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import {
    type DeliveredFile,
    type DeliveryConflictReason,
    PROJECT_DELIVERY_MAX_BYTES,
    type ProjectDelivery,
    type ProjectDeliveryResult,
} from "@intentic/sandbox-contract";
import { baseDir } from "../config.js";
import { deliversByItself, isProjectPairing, type Pairing, pairingKey, readState } from "./config.js";
import { runProcess } from "./exec.js";
import { ensureMutagen, sessionName } from "./mutagen.js";
import { isPortablePath } from "./project-files.js";
import { assertFolder, type Durability, hashFile, installFile, localFile, localTarget, realDurability, removeFile } from "./project-local.js";
import { mutagenSession, realProjectRunner } from "./project-remote.js";
import { clearStaging, exclusively, type FolderContext, folderStateDir, type ProjectPairing, whileHeld } from "./project-transfer.js";
import { backUp, createPointDir, pruneRestorePoints, type RestoreEntry, sealPoint, writeManifest } from "./restore-points.js";

// LANDED WORK WRITTEN INTO THE OWNER'S FOLDER (`deliverProject` on the device link, the contract's
// schemas/project-delivery.ts). A folder attached to this computer's sandbox is copied one way into `/work/<name>`; when
// a conversation's work lands there, the daemon hands the same change here, and this agent decides, file by file, what
// the folder takes. The rules are a bring-back's (project-transfer.ts), and so is everything that keeps them:
// - Only a folder that opted in (`deliver: "auto"`, which `sync attach` records), of the sandbox on the other end of the
//   link that asks. Nothing an agent runs can ask: this is a procedure of the link, not one of its tools.
// - Under the folder's lock, with its session flushed and held still, as a bring-back is.
// - A restore point before the first write, in the bring-back's own shape, so `sync restore --point <id>` undoes a
//   delivery unchanged. None when nothing is written.
// - NEVER OVER THE OWNER'S OWN EDIT. A file is written as landed only where the folder still holds what the land started
//   from (`base`); one the owner changed too is merged three ways by git when all three are text and the merge is clean,
//   and is otherwise left as the owner has it, named in `conflicts`.
//
// WHY THE SESSION AGREES AFTERWARDS: the sandbox's copy already holds what landed, so a file written here as landed has
// moved on both sides to the same bytes, which Mutagen records as agreement. A merged one differs from the sandbox's
// until the daemon writes the merge there too, which is why its content goes back in the answer.

// A delivery the agent turns away whole, with the sentence the land's card shows and the oRPC code it travels as.
export class DeliveryRefused extends Error {
    readonly code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND";

    constructor(message: string, code: DeliveryRefused["code"]) {
        super(message);
        this.code = code;
    }
}

const hostOf = (url: string): string | undefined => (URL.canParse(url) ? new URL(url).host.toLowerCase() : undefined);

// THE FOLDER A DELIVERY IS FOR: the project pairing whose sandbox folder is `remoteDir`, of the sandbox at `sandboxUrl`
// (the link that asked), and only one that opted into delivery. A folder of another sandbox is never this link's to
// write into, however its remote dir is spelled.
export const deliveryPairingFor = (pairings: readonly Pairing[], sandboxUrl: string, remoteDir: string): ProjectPairing => {
    const wanted = hostOf(sandboxUrl);
    const paired = pairings.flatMap((pairing) =>
        pairing.localDir !== undefined && isProjectPairing(pairing) && pairing.remoteDir === remoteDir && hostOf(pairing.sandboxUrl) === wanted
            ? [{ ...pairing, localDir: pairing.localDir }]
            : [],
    );
    const first = paired[0];
    if (first === undefined) {
        throw new DeliveryRefused(`No folder on this computer is attached as ${remoteDir} of ${sandboxUrl}.`, "NOT_FOUND");
    }
    const delivering = paired.find(deliversByItself);
    if (delivering === undefined) {
        throw new DeliveryRefused(`${first.localDir} takes landed work only through Bring back: it did not opt into delivery.`, "FORBIDDEN");
    }
    return delivering;
};

// One delivered file, its two contents decoded.
interface Decoded {
    readonly file: DeliveredFile;
    readonly base: Buffer | null;
    readonly next: Buffer | null;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// How many bytes a base64 string decodes to, read off its length before anything is decoded.
const decodedLength = (value: string | null): number => (value === null ? 0 : (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0));

const decoded = (value: string | null, path: string): Buffer | null => {
    if (value === null) {
        return null;
    }
    if (value.length % 4 !== 0 || !BASE64.test(value)) {
        throw new DeliveryRefused(`The delivery of ${JSON.stringify(path)} is not base64.`, "BAD_REQUEST");
    }
    return Buffer.from(value, "base64");
};

// Which contents each kind carries: an addition no base, a deletion no next, a modification both.
const kindHolds = (file: DeliveredFile): boolean =>
    file.kind === "added" ? file.base === null && file.next !== null : file.kind === "deleted" ? file.base !== null && file.next === null : file.base !== null && file.next !== null;

// The delivery read whole before the folder is looked at: its size bounded by the contract's, each file's contents
// decoded and of its kind, no path twice. A delivery that fails any of it is a daemon's fault, refused whole.
export const decodeDelivery = (delivery: ProjectDelivery): readonly Decoded[] => {
    const total = delivery.files.reduce((sum, file) => sum + decodedLength(file.base) + decodedLength(file.next), 0);
    if (total > PROJECT_DELIVERY_MAX_BYTES) {
        throw new DeliveryRefused(`The delivery carries ${total} bytes, past the ${PROJECT_DELIVERY_MAX_BYTES} one call may; Bring back reaches its files.`, "BAD_REQUEST");
    }
    const seen = new Set<string>();
    return delivery.files.map((file) => {
        if (seen.has(file.path)) {
            throw new DeliveryRefused(`The delivery names ${JSON.stringify(file.path)} twice.`, "BAD_REQUEST");
        }
        seen.add(file.path);
        if (!kindHolds(file)) {
            throw new DeliveryRefused(`The delivery of ${JSON.stringify(file.path)} says ${file.kind} but does not carry what that kind does.`, "BAD_REQUEST");
        }
        return { file, base: decoded(file.base, file.path), next: decoded(file.next, file.path) };
    });
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// Git's own test for binary content: a NUL in the first 8000 bytes.
const TEXT_WINDOW = 8000;
const isText = (bytes: Buffer): boolean => !bytes.subarray(0, TEXT_WINDOW).includes(0);

const fileIsText = async (path: string): Promise<boolean> => {
    const handle = await open(path, "r");
    try {
        const window = Buffer.alloc(TEXT_WINDOW);
        const { bytesRead } = await handle.read(window, 0, TEXT_WINDOW, 0);
        return isText(window.subarray(0, bytesRead));
    } finally {
        await handle.close();
    }
};

// A path the folder may take: inside it, portable, and never into a repository's own `.git` (any case, since the disks
// that ignore case would read `.GIT` as it).
const insideFolder = (path: string): boolean => isPortablePath(path) && !path.split("/").some((part) => part.toLowerCase() === ".git");

// What one file comes to before anything is written.
type Plan =
    | { readonly path: string; readonly outcome: "already" }
    | { readonly path: string; readonly outcome: "conflict"; readonly reason: DeliveryConflictReason }
    // Merged with the owner's edit to exactly what the folder already holds: nothing to write, the content still answered.
    | { readonly path: string; readonly outcome: "merged-in-place"; readonly content: Buffer }
    | {
          readonly path: string;
          readonly outcome: "write";
          readonly kind: "added" | "modified";
          // The file that will be put in place, staged beside the restore points.
          readonly source: string;
          readonly hash: string;
          // What the folder held when this was decided (null for none), so an edit made since is never written over.
          readonly before: string | null;
          readonly executable: boolean;
          readonly merged?: Buffer;
      }
    | { readonly path: string; readonly outcome: "remove"; readonly before: string };

type Write = Extract<Plan, { readonly outcome: "write" | "remove" }>;

const conflict = (path: string, reason: DeliveryConflictReason): Plan => ({ path, outcome: "conflict", reason });

// What the folder holds at a path now: absent (null) or a regular file's sha256, or why it may not be written at all.
type Holding = { readonly target: string; readonly hash: string | null } | { readonly refused: DeliveryConflictReason };

const holding = async (root: string, path: string): Promise<Holding> => {
    if (!insideFolder(path)) {
        return { refused: "outside" };
    }
    let target: string;
    try {
        target = await localTarget(root, path);
    } catch {
        // allow(silent-catch): a link, or a folder or something else standing where a file goes, is the answer.
        return { refused: "link" };
    }
    const info = await lstat(target).catch(undefinedIfMissing);
    return { target, hash: info === undefined ? null : await hashFile(target) };
};

// How long one three-way merge may take; git answers in milliseconds, so this bounds only a hung one.
const MERGE_TIMEOUT_MS = 60_000;

// The owner's edit and the landed change merged by `git merge-file`, which writes the result over its first file in
// place (byte for byte, whatever the text's encoding: stdout would come back decoded). Undefined when it did not merge
// cleanly; its exit code is the number of conflicts.
const mergeThreeWays = async (git: string, dir: string, current: string, base: Buffer, next: Buffer): Promise<Buffer | undefined> => {
    await mkdir(dir, { mode: 0o700 });
    const ours = join(dir, "current");
    const ancestor = join(dir, "base");
    const theirs = join(dir, "next");
    await copyFile(current, ours);
    await writeFile(ancestor, base, { mode: 0o600 });
    await writeFile(theirs, next, { mode: 0o600 });
    const merged = await runProcess(git, ["merge-file", "-q", ours, ancestor, theirs], { cwd: dir, timeoutMs: MERGE_TIMEOUT_MS });
    return merged.status === 0 ? await readFile(ours) : undefined;
};

// THE RULES, one file at a time, nothing written yet (the merge runs on copies in the staging folder).
const planFile = async (root: string, item: Decoded, staging: string, at: number, git: () => Promise<string | undefined>): Promise<Plan> => {
    const { file, base, next } = item;
    const here = await holding(root, file.path);
    if ("refused" in here) {
        return conflict(file.path, here.refused);
    }
    const baseHash = base === null ? null : sha256(base);
    if (next === null) {
        if (here.hash === null) {
            return { path: file.path, outcome: "already" };
        }
        return here.hash === baseHash ? { path: file.path, outcome: "remove", before: here.hash } : conflict(file.path, "edited");
    }
    const nextHash = sha256(next);
    if (here.hash === nextHash) {
        return { path: file.path, outcome: "already" };
    }
    const staged = async (bytes: Buffer): Promise<string> => {
        const source = join(staging, String(at));
        await writeFile(source, bytes, { mode: 0o600 });
        return source;
    };
    if (here.hash === baseHash) {
        // As landed: an addition where the folder has nothing, or a change of a file the owner has not touched.
        const kind = here.hash === null ? "added" : "modified";
        return { path: file.path, outcome: "write", kind, source: await staged(next), hash: nextHash, before: here.hash, executable: file.executable === true };
    }
    // The owner moved it too. Only a file both sides still hold can be merged: one the owner deleted, or made where the
    // land added one, is theirs.
    if (here.hash === null || base === null) {
        return conflict(file.path, "edited");
    }
    if (!isText(base) || !isText(next) || !(await fileIsText(here.target))) {
        return conflict(file.path, "edited");
    }
    const gitPath = await git();
    if (gitPath === undefined) {
        return conflict(file.path, "missing-git");
    }
    const merged = await mergeThreeWays(gitPath, join(staging, `merge-${at}`), here.target, base, next);
    if (merged === undefined) {
        return conflict(file.path, "edited");
    }
    const hash = sha256(merged);
    if (hash === here.hash) {
        return { path: file.path, outcome: "merged-in-place", content: merged };
    }
    return { path: file.path, outcome: "write", kind: "modified", source: await staged(merged), hash, before: here.hash, executable: false, merged };
};

// One planned write carried out, only where the folder still holds what the restore point kept of it (or nothing, for
// a file being added): an edit made meanwhile is the owner's, and is left alone.
const carryOut = async (root: string, plan: Write, entry: RestoreEntry): Promise<void> => {
    const current = await localFile(root, plan.path);
    if ((current?.hash ?? null) !== (entry.backedUp ? entry.backup : null)) {
        throw new Error("it changed here while it was being delivered");
    }
    if (plan.outcome === "remove") {
        await removeFile(root, plan.path);
        return;
    }
    await installFile(root, plan.path, plan.source, current === undefined ? { executable: plan.executable } : { exact: current.mode });
};

const backupKind = (plan: Write): "added" | "modified" | "deleted" => (plan.outcome === "remove" ? "deleted" : plan.kind);

export interface DeliveryContext extends FolderContext {
    // How a restore point is flushed to the disk; the real flush unless a test watches the order.
    readonly durability?: Durability;
    // The git a three-way merge runs, undefined where this machine has none; asked only when a merge is needed.
    readonly git?: () => Promise<string | undefined>;
}

interface PointPlace {
    readonly stateDir: string;
    readonly key: string;
    readonly id: string;
    readonly root: string;
    readonly durability: Durability;
}

// Each planned write's file copied into the point. A file that moved since it was planned (appeared, vanished or
// changed) is the owner's, and is left out of both the point and the writes, named in `conflicts`.
const backUpWrites = async (place: PointPlace, writes: readonly Write[], conflicts: { path: string; reason: DeliveryConflictReason }[]): Promise<{ readonly plan: Write; readonly entry: RestoreEntry }[]> => {
    const kept: { readonly plan: Write; readonly entry: RestoreEntry }[] = [];
    for (const plan of writes) {
        try {
            const request = { path: plan.path, kind: backupKind(plan), applied: plan.outcome === "remove" ? null : plan.hash };
            // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time, so a failure names one path
            const entry = await backUp(place.stateDir, place.key, place.id, place.root, request, place.durability);
            if ((entry.backedUp ? (entry.backup ?? null) : null) === plan.before) {
                kept.push({ plan, entry });
            } else {
                conflicts.push({ path: plan.path, reason: "edited" });
            }
        } catch {
            // allow(silent-catch): a file that appeared, vanished or changed while it was backed up is the owner's edit.
            conflicts.push({ path: plan.path, reason: "edited" });
        }
    }
    return kept;
};

// `git` on PATH, if it answers.
const gitOnPath = async (): Promise<string | undefined> => ((await runProcess("git", ["--version"], { timeoutMs: 10_000 })).status === 0 ? "git" : undefined);

const deliverHeld = async (context: DeliveryContext, delivery: ProjectDelivery, items: readonly Decoded[], staging: string): Promise<ProjectDeliveryResult> => {
    const { pairing, stateDir } = context;
    const root = pairing.localDir;
    const durability = context.durability ?? realDurability;
    let git: Promise<string | undefined> | undefined;
    const askGit = async (): Promise<string | undefined> => await (git ??= (context.git ?? gitOnPath)());
    const plans: Plan[] = [];
    for (const [at, item] of items.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- one file at a time, so a failure names one path
        plans.push(await planFile(root, item, staging, at, askGit));
    }
    const conflicts = plans.flatMap((plan) => (plan.outcome === "conflict" ? [{ path: plan.path, reason: plan.reason }] : []));
    const already = plans.flatMap((plan) => (plan.outcome === "already" ? [plan.path] : []));
    const mergedInPlace = plans.flatMap((plan) => (plan.outcome === "merged-in-place" ? [{ path: plan.path, content: plan.content.toString("base64") }] : []));
    const writes = plans.filter((plan): plan is Write => plan.outcome === "write" || plan.outcome === "remove");
    if (writes.length === 0) {
        return { folder: root, applied: [], merged: mergedInPlace, already, conflicts };
    }
    // THE RESTORE POINT, before anything here is touched: each file about to be overwritten or deleted copied into it,
    // and all of it on the disk (sealPoint) before the first write.
    const key = pairingKey(pairing);
    const point = await createPointDir(stateDir, key, Date.now());
    const kept = await backUpWrites({ stateDir, key, id: point.id, root, durability }, writes, conflicts);
    const manifest = { id: point.id, createdAt: point.createdAt, dir: root, entries: kept.map(({ entry }) => entry), landing: delivery.landing };
    await writeManifest(stateDir, key, manifest);
    await sealPoint(stateDir, key, point.id, durability);
    const done: { readonly plan: Write; readonly entry: RestoreEntry }[] = [];
    for (const item of kept) {
        try {
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await carryOut(root, item.plan, item.entry);
            done.push(item);
        } catch {
            // allow(silent-catch): the one way a planned write fails here is the folder having moved under it.
            conflicts.push({ path: item.plan.path, reason: "edited" });
        }
    }
    // What a restore can undo is what happened: the point is cut to the entries that were written.
    await writeManifest(stateDir, key, { ...manifest, entries: done.map(({ entry }) => entry) });
    const merged = done.flatMap(({ plan }) => (plan.outcome === "write" && plan.merged !== undefined ? [{ path: plan.path, content: plan.merged.toString("base64") }] : []));
    return {
        // A point that holds nothing is never named: retention clears it (restore-points.ts).
        ...(done.length === 0 ? {} : { point: point.id }),
        folder: root,
        applied: done.flatMap(({ plan }) => (plan.outcome === "write" && plan.merged !== undefined ? [] : [plan.path])),
        merged: [...merged, ...mergedInPlace],
        already,
        conflicts,
    };
};

// THE DELIVERY into the folder `context` holds: the delivery read whole first, then the folder locked, its session
// flushed and held still, and every file planned, backed up and written as the rules above say. Retention runs after,
// under the same lock, as it does after a bring-back.
export const deliverToFolder = async (context: DeliveryContext, delivery: ProjectDelivery): Promise<ProjectDeliveryResult> => {
    const items = decodeDelivery(delivery);
    return await exclusively(context, async () => {
        await assertFolder(context.pairing.localDir);
        const dir = folderStateDir(context);
        await clearStaging(dir);
        const result = await whileHeld(
            context,
            true,
            async () => {
                const staging = await mkdtemp(join(dir, ".staging-"));
                try {
                    return await deliverHeld(context, delivery, items, staging);
                } finally {
                    await rm(staging, { recursive: true, force: true });
                }
            },
            (done) => `Delivered ${done.applied.length + done.merged.length} file(s) into ${context.pairing.localDir}`,
        );
        await pruneRestorePoints(context.stateDir, pairingKey(context.pairing), Date.now(), result.point);
        return result;
    });
};

// What the device link's `deliverProject` runs: the folder found for the sandbox at `sandboxUrl`, its session reached
// by the name the watcher gives it.
export const deliverProject = async (delivery: ProjectDelivery, sandboxUrl: string): Promise<ProjectDeliveryResult> => {
    const pairing = deliveryPairingFor((await readState()).pairings, sandboxUrl, delivery.remoteDir);
    const session = mutagenSession(realProjectRunner, await ensureMutagen(), sessionName(pairingKey(pairing)));
    return await deliverToFolder({ pairing, stateDir: baseDir, session }, delivery);
};
