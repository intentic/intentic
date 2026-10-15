import type { BigIntStats, Dirent } from "node:fs";
import { lstat, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Delayer } from "@intentic/base/async";
import { isMissing, undefinedIfMissing } from "@intentic/base/errors";
import { DERIVED_SHADOWS_DIR, STATE_DIR } from "@intentic/constants";
import { documentFormatOf } from "@intentic/fileq/formats";
import { ocrCapOf, parseSidecarFront, sidecarPathFor, sourceStatOf, sourceUnchanged } from "@intentic/fileq/sidecar";
import { IGNORED_DIRS, isAgentWorktreePath, isBrowserProfilePath, isReferencePath } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { z } from "zod";
import { onPath } from "../image/on-path.js";
import { defaultExec, FILEQ_MAX_BUFFER, isMissingBinary, runFailure, stdoutOf, withFileqSlot, type ExecFn } from "./fileq.js";

// The shadow keeper: every document in the main workspace (pdf, docx, xlsx, pptx, odt, ods, odp, rtf, epub, as fileq's
// formats.ts names them) has a current text shadow under .intentic/local/cache/derived, so ripgrep (through fileq's
// preprocessor) and iq can search what documents say without anyone having opened them first.
// - On boot, a sweep walks the tree once, derives every document whose shadow is missing or stale, and removes shadows
//   whose document is gone. Stale here is the hash-free test: the shadow's recorded size and mtime are not the file's,
//   its deriver stamp is not the one fileq would write now (`fileq stamps`), or its OCR stopped short of this keeper's
//   page cap. fileq itself still hashes before it derives, so a touched-but-unchanged file costs a read, not a render.
// - Then the workspace watcher's batches: a created or changed document is queued, a deleted or renamed one loses its
//   shadow, after a short debounce so a burst of saves renders once.
// Low priority throughout: one fileq child at a time, under `nice` where it exists, in the slot budget it shares with
// interactive renders, which go first (fileq.ts). A file fileq refused (corrupt, encrypted) is not asked again until it
// changes. Skipped: IGNORED_DIRS, `.intentic`, `refs/`, agent worktrees, browser profiles, files over MAX_BYTES; and a
// workspace holding more than MAX_DOCUMENTS documents is reported rather than ground through.
// Background OCR goes deeper than an interactive read (KEEPER_OCR_PAGES, against fileq's 20). Where OCR is not
// available fileq's shadow says so under the `pdf` stamp, and nothing re-derives it until the stamp changes, which is
// what installing the OCR pack does.

export const KEEPER_OCR_PAGES = 500;
export const MAX_DOCUMENTS = 20_000;
export const MAX_BYTES = 200 * 1024 * 1024;
// Files per fileq run: one Node start per batch, short enough that a turned-off setting or a stop lands soon.
const BATCH = 8;
// Generous: a batch can hold a long scan being OCR'd page by page, and nobody is waiting on it.
const BATCH_TIMEOUT_MS = 2 * 60 * 60 * 1000;
// Saves come in bursts (an editor's temp file, a sync client); one render per burst.
export const CHANGE_DEBOUNCE_MS = 2_000;
// After a batch too big to name: one sweep, once the burst (a clone, an unpacked archive) has settled.
const OVERFLOW_SWEEP_MS = 30_000;
// Front matter only; its notes can run long, and a shadow's body can be megabytes.
const HEAD_BYTES = 64 * 1024;

export interface ShadowKeeperDeps {
    readonly root: string;
    /** The sandbox setting; read before every sweep and every batch, so turning it off stops the work in hand. */
    readonly enabled: () => Promise<boolean>;
    readonly logger: Pick<Logger, "info" | "warn">;
    /** Shadows were written or removed: iq re-indexes them (the watcher does not look under .intentic/local/cache). */
    readonly onShadowsChanged: () => void;
    readonly exec?: ExecFn;
    readonly limits?: { readonly maxDocuments?: number; readonly maxBytes?: number; readonly debounceMs?: number };
}

export interface SweepReport {
    readonly state: "done" | "off" | "too-many" | "no-fileq" | "stopped";
    /** Documents found in the walk (capped at maxDocuments + 1). */
    readonly documents: number;
    /** Documents that needed a render and were handed to fileq. */
    readonly queued: number;
    readonly removed: number;
}

export interface ShadowKeeper {
    readonly sweep: () => Promise<SweepReport>;
    /** One watcher batch, workspace-relative; an empty batch means "too many to name", and books a sweep instead. */
    readonly changed: (paths: readonly string[]) => void;
    /** The setting may have moved: a keeper that was off and is now on sweeps. */
    readonly reconsider: () => Promise<void>;
    /** Settles once every change heard so far and every render queued has been applied. */
    readonly idle: () => Promise<void>;
    readonly stop: () => void;
}

// What `fileq derive --json` prints per file, and what `fileq stamps` prints once.
const OutcomeLineSchema = z.object({ kind: z.string(), relPath: z.string().optional(), reason: z.string().optional() });
const StampsSchema = z.record(z.string(), z.string());

const outcomesOf = (stdout: string): z.infer<typeof OutcomeLineSchema>[] =>
    stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .flatMap((line) => {
            const parsed = OutcomeLineSchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
        });

const isSkipped = (relPath: string): boolean =>
    relPath.split("/").some((segment) => IGNORED_DIRS.has(segment) || segment === STATE_DIR) ||
    isReferencePath(relPath) ||
    isAgentWorktreePath(relPath) ||
    isBrowserProfilePath(relPath);

const statKey = (stats: BigIntStats): string => {
    const { size, mtime } = sourceStatOf(stats);
    return `${size} ${mtime}`;
};

const statOf = (path: string): Promise<BigIntStats | undefined> => stat(path, { bigint: true }).catch(undefinedIfMissing);

// Undefined when the path is gone; the stats otherwise, including for a path this process cannot read.
const presenceOf = async (path: string): Promise<{ readonly gone: boolean; readonly isFile: boolean }> => {
    try {
        return { gone: false, isFile: (await lstat(path)).isFile() };
    } catch (error) {
        return { gone: isMissing(error), isFile: false };
    }
};

// The shadow's front matter, read without its body; undefined when there is no shadow.
const readHead = async (path: string): Promise<string | undefined> => {
    const handle = await open(path, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return undefined;
    }
    try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
        await handle.close();
    }
};

const listDir = (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch((): Dirent[] => []);

export const createShadowKeeper = (deps: ShadowKeeperDeps): ShadowKeeper => {
    const exec = deps.exec ?? defaultExec;
    const maxDocuments = deps.limits?.maxDocuments ?? MAX_DOCUMENTS;
    const maxBytes = BigInt(deps.limits?.maxBytes ?? MAX_BYTES);
    const derivedRoot = join(deps.root, DERIVED_SHADOWS_DIR);
    const childEnv = { ...process.env, WORKSPACE_ROOT: deps.root };
    let stamps: Record<string, string> = {};
    let stopped = false;
    // relPath → the stat fileq refused it at; not asked again until the file changes.
    const refused = new Map<string, string>();
    const queue = new Set<string>();
    let draining: Promise<void> | undefined;
    const pendingChanges = new Set<string>();
    let settling: Promise<void> | undefined;
    const debounce = new Delayer<void>(deps.limits?.debounceMs ?? CHANGE_DEBOUNCE_MS, { unref: true });
    const overflow = new Delayer<SweepReport>(OVERFLOW_SWEEP_MS, { unref: true });
    // What the last sweep found the setting to be; `reconsider` sweeps on its way from off to on.
    let lastState: SweepReport["state"] | undefined;

    // Whether a document's shadow must be rendered (again): the whole hash-free freshness test.
    const needsRender = async (relPath: string): Promise<boolean> => {
        const source = await statOf(join(deps.root, relPath));
        if (source === undefined || !source.isFile() || source.size > maxBytes || refused.get(relPath) === statKey(source)) {
            return false;
        }
        const head = await readHead(sidecarPathFor(deps.root, relPath));
        if (head === undefined) {
            return true;
        }
        const front = parseSidecarFront(head);
        const stamp = stamps[documentFormatOf(relPath) ?? ""];
        const restamped = stamp !== undefined && front.deriver !== stamp;
        const shallow = (ocrCapOf(front.notes) ?? Number.POSITIVE_INFINITY) < KEEPER_OCR_PAGES;
        return restamped || shallow || !sourceUnchanged(front, sourceStatOf(source));
    };

    // The shadow file, and a folder of shadows when what went was a folder of documents.
    const removeShadow = async (relPath: string): Promise<boolean> => {
        const shadow = await presenceOf(sidecarPathFor(deps.root, relPath));
        const folder = join(derivedRoot, relPath);
        const folderPresent = !(await presenceOf(folder)).gone;
        await rm(sidecarPathFor(deps.root, relPath), { force: true });
        if (folderPresent) {
            await rm(folder, { recursive: true, force: true });
        }
        return !shadow.gone || folderPresent;
    };

    // One fileq run, nice'd where `nice` exists, in a background slot; answers what it printed.
    const runFileq = async (batch: readonly string[]): Promise<string> => {
        const args = ["derive", "--json", "--ocr-pages", String(KEEPER_OCR_PAGES), ...batch];
        const nice = await onPath("nice");
        const options = { timeout: BATCH_TIMEOUT_MS, maxBuffer: FILEQ_MAX_BUFFER, cwd: deps.root, env: childEnv };
        try {
            const run = (): Promise<{ stdout: string }> => (nice ? exec("nice", ["-n", "19", "fileq", ...args], options) : exec("fileq", args, options));
            return (await withFileqSlot(run, "background")).stdout;
        } catch (error) {
            if (isMissingBinary(error)) {
                throw error;
            }
            // Exit 1 is "nothing here was derivable", and its lines still say which; anything else ends this batch.
            const failure = runFailure(error);
            if (failure !== undefined) {
                deps.logger.warn({ files: batch.length, failure }, "shadow keeper: a fileq run failed; its files are tried again when they change");
            }
            return stdoutOf(error);
        }
    };

    // One batch through fileq; answers whether any shadow moved.
    const renderBatch = async (batch: readonly string[]): Promise<boolean> => {
        let moved = false;
        for (const outcome of outcomesOf(await runFileq(batch))) {
            moved ||= outcome.kind === "derived" || outcome.kind === "fresh" || outcome.kind === "removed";
            if (outcome.kind !== "skipped" || outcome.relPath === undefined || outcome.reason === "missing") {
                continue;
            }
            const source = await statOf(join(deps.root, outcome.relPath));
            if (source !== undefined) {
                refused.set(outcome.relPath, statKey(source));
            }
        }
        return moved;
    };

    const drain = async (): Promise<void> => {
        while (queue.size > 0 && !stopped && (await deps.enabled())) {
            const batch = [...queue].slice(0, BATCH);
            for (const relPath of batch) {
                queue.delete(relPath);
            }
            try {
                if (await renderBatch(batch)) {
                    deps.onShadowsChanged();
                }
            } catch (error) {
                deps.logger.warn({ err: error }, "shadow keeper: fileq is not on PATH, so no document gets a shadow in the background");
                stopped = true;
            }
        }
        queue.clear();
    };

    const enqueue = (relPaths: readonly string[]): Promise<void> => {
        for (const relPath of relPaths) {
            queue.add(relPath);
        }
        draining ??= drain().finally(() => {
            draining = undefined;
        });
        return draining;
    };

    // Shadows whose file is gone, removed: any shadow, a picture's someone opened as much as a document's.
    const pruneOrphans = async (): Promise<number> => {
        let removed = 0;
        const walk = async (dir: string, rel: string): Promise<void> => {
            for (const entry of await listDir(dir)) {
                // `.by-hash` (the content cache) and `.gitignore` are fileq's own, not shadows.
                if (stopped || (rel === "" && entry.name.startsWith("."))) {
                    continue;
                }
                const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
                if (entry.isDirectory()) {
                    await walk(join(dir, entry.name), relPath);
                } else if (entry.name.endsWith(".md") && (await presenceOf(join(deps.root, relPath.slice(0, -3)))).gone) {
                    await rm(join(dir, entry.name), { force: true });
                    removed += 1;
                }
            }
        };
        await walk(derivedRoot, "");
        return removed;
    };

    // Every document the keeper looks after, up to one past the cap; stops descending once over it.
    const findDocuments = async (): Promise<string[]> => {
        const found: string[] = [];
        const walk = async (dir: string, rel: string): Promise<void> => {
            for (const entry of await listDir(dir)) {
                if (found.length > maxDocuments || stopped) {
                    return;
                }
                const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
                if (entry.isSymbolicLink() || isSkipped(relPath)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    await walk(join(dir, entry.name), relPath);
                } else if (entry.isFile() && documentFormatOf(relPath) !== undefined) {
                    found.push(relPath);
                }
            }
        };
        await walk(deps.root, "");
        return found;
    };

    // fileq's stamps for this image; undefined when there is no fileq to ask at all.
    const readStamps = async (): Promise<Record<string, string> | undefined> => {
        try {
            const { stdout } = await exec("fileq", ["stamps"], { timeout: 60_000, maxBuffer: 64 * 1024, cwd: deps.root, env: childEnv });
            return StampsSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}"));
        } catch (error) {
            if (isMissingBinary(error)) {
                return undefined;
            }
            deps.logger.warn({ err: error }, "shadow keeper: could not read fileq's stamps; shadows are judged by size and mtime alone");
            return {};
        }
    };

    const sweep = async (): Promise<SweepReport> => {
        if (!(await deps.enabled())) {
            return { state: "off", documents: 0, queued: 0, removed: 0 };
        }
        const read = await readStamps();
        if (read === undefined) {
            return { state: "no-fileq", documents: 0, queued: 0, removed: 0 };
        }
        stamps = read;
        const removed = await pruneOrphans();
        if (removed > 0) {
            deps.onShadowsChanged();
        }
        const documents = await findDocuments();
        if (documents.length > maxDocuments) {
            deps.logger.warn(
                { root: deps.root, cap: maxDocuments },
                "shadow keeper: this workspace holds more documents than the keeper sweeps; only documents that change get a shadow, the rest when someone reads them",
            );
            return { state: "too-many", documents: documents.length, queued: 0, removed };
        }
        const stale: string[] = [];
        for (const relPath of documents) {
            if (!stopped && (await needsRender(relPath))) {
                stale.push(relPath);
            }
        }
        deps.logger.info({ documents: documents.length, stale: stale.length, removed }, "shadow keeper: swept the workspace's documents");
        await enqueue(stale);
        return { state: stopped ? "stopped" : "done", documents: documents.length, queued: stale.length, removed };
    };

    const settleChanges = async (): Promise<void> => {
        const paths = [...pendingChanges];
        pendingChanges.clear();
        if (!(await deps.enabled())) {
            return;
        }
        let removed = false;
        const render: string[] = [];
        for (const relPath of paths) {
            const presence = await presenceOf(join(deps.root, relPath));
            if (presence.gone) {
                removed = (await removeShadow(relPath)) || removed;
            } else if (presence.isFile && documentFormatOf(relPath) !== undefined && (await needsRender(relPath))) {
                render.push(relPath);
            }
        }
        if (removed) {
            deps.onShadowsChanged();
        }
        await enqueue(render);
    };

    const guardedSweep = async (): Promise<SweepReport> => {
        const report = await sweep().catch((err): SweepReport => {
            deps.logger.warn({ err }, "shadow keeper: the sweep failed");
            return { state: "stopped", documents: 0, queued: 0, removed: 0 };
        });
        lastState = report.state;
        return report;
    };

    const changed = (paths: readonly string[]): void => {
        if (paths.length === 0 && !stopped) {
            void overflow.trigger(guardedSweep);
            return;
        }
        // Documents for a render or a removal; any other path that went may be a folder that held some.
        for (const relPath of paths) {
            if (!stopped && !isSkipped(relPath)) {
                pendingChanges.add(relPath);
            }
        }
        if (pendingChanges.size === 0) {
            return;
        }
        // The window's own promise: every change heard inside one window settles together.
        settling = debounce.trigger(settleChanges).catch((err) => deps.logger.warn({ err }, "shadow keeper: a change could not be applied"));
    };

    return {
        sweep: guardedSweep,
        reconsider: async () => {
            if (lastState === "off" && !stopped && (await deps.enabled())) {
                await guardedSweep();
            }
        },
        changed,
        idle: async () => {
            await settling;
            await draining;
        },
        stop: () => {
            stopped = true;
            queue.clear();
            debounce.dispose();
            overflow.dispose();
        },
    };
};
