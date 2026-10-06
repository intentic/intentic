import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
    STORAGE_CLEANABILITY,
    type StorageCategoryId,
    type StorageCleanResult,
    type StorageReport,
    type StorageScan,
    StorageScanSchema,
} from "@intentic/sandbox-contract";
import { FLY_VOLUME_LAYOUT, FLY_VOLUME_PATH } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import { cacheFile } from "../../../store/open-document.js";
import { cleanCategory } from "./storage-clean.js";
import type { StorageRoots } from "./storage-catalog.js";
import { scanStorage } from "./storage-scan.js";
import { isAbortError } from "./storage-walk.js";
import type { RunningProgram } from "./running-programs.js";

// The one scan a daemon runs at a time, the last one it finished, and the one clean it runs at a time. The last scan is
// also kept on the history volume, so a restart or a rebuild still has an answer: an old measurement, dated, beats an
// empty card the owner has to fill with minutes of disk reads before they learn anything.

// Long enough for a million files on a busy volume; a scan that runs out answers `partial` rather than never.
const SCAN_BUDGET_MS = 120_000;

export interface DiskStorage {
    readonly report: () => Promise<StorageReport>;
    // Joins the scan in flight, or starts one; resolves once it ends, with the previous result if it was cancelled.
    readonly scan: () => Promise<StorageReport>;
    readonly cancel: () => void;
    readonly clean: (category: StorageCategoryId) => Promise<StorageCleanResult | "not cleanable" | "already cleaning">;
}

export interface DiskStorageOptions {
    // The volumes as configured; resolved to real paths per scan, since `/work` is a link on a hosted machine.
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly logger: Logger;
    readonly programs: () => Promise<readonly RunningProgram[]>;
    readonly prune: (storeDir: string) => Promise<boolean>;
    readonly now?: () => number;
    readonly budgetMs?: number;
}

// The real paths a walk starts from; a hosted machine links both onto its one volume, whose other residents (the
// nested Docker's data, a pnpm store at its top) fill the same disk and so are walked too.
export const resolveStorageRoots = async (workspaceRoot: string, historyRoot: string): Promise<StorageRoots> => {
    const real = (path: string): Promise<string> => realpath(path).catch(() => resolve(path));
    const [workspace, history] = await Promise.all([real(workspaceRoot), real(historyRoot)]);
    return workspace === FLY_VOLUME_LAYOUT.workspace ? { workspace, history, volume: FLY_VOLUME_PATH } : { workspace, history };
};

// Where the last finished scan is kept. A cache: one this build cannot read (a shape since changed) reads as none.
const lastScanFile = (historyRoot: string) =>
    cacheFile<StorageScan | undefined>(join(historyRoot, "storage-scan.json"), {
        parse: (raw) => StorageScanSchema.safeParse(raw).data,
        fallback: () => undefined,
    });

export const createDiskStorage = (options: DiskStorageOptions): DiskStorage => {
    const now = options.now ?? Date.now;
    const kept = lastScanFile(options.historyRoot);
    let last: StorageScan | undefined;
    let scanning: { readonly controller: AbortController; readonly done: Promise<StorageReport> } | undefined;
    let cleaning: Promise<unknown> | undefined;

    // A scan that finishes before the kept one is read is newer, so the read never replaces it.
    // allow(silent-catch): an unreadable cache is no measurement, which is what the card shows before a first scan
    const loaded = kept.read().then((scan) => (last ??= scan), () => undefined);
    const report = async (): Promise<StorageReport> => {
        await loaded;
        return { ...(last === undefined ? {} : { scan: last }), scanning: scanning !== undefined };
    };

    const run = async (controller: AbortController): Promise<StorageReport> => {
        // A clean mid-flight would have the scan count what is about to go; it measures the disk after instead.
        await cleaning;
        try {
            const roots = await resolveStorageRoots(options.workspaceRoot, options.historyRoot);
            last = await scanStorage({
                roots,
                shown: { workspace: options.workspaceRoot, history: options.historyRoot },
                now,
                budgetMs: options.budgetMs ?? SCAN_BUDGET_MS,
                signal: controller.signal,
                programs: options.programs,
            });
            options.logger.info({ outcome: last.outcome, ms: last.finishedAt - last.startedAt, unreadable: last.unreadable }, "storage: scanned the disk");
            const measured = last;
            await kept.update(() => measured).catch((error: unknown) => options.logger.warn({ err: error }, "storage: could not keep the scan"));
        } catch (error) {
            if (!isAbortError(error)) {
                throw error;
            }
        } finally {
            scanning = undefined;
        }
        return report();
    };

    const cancel = (): void => scanning?.controller.abort();

    return {
        report,
        scan: () => {
            if (scanning !== undefined) {
                return scanning.done;
            }
            const controller = new AbortController();
            const done = run(controller);
            scanning = { controller, done };
            return done;
        },
        cancel,
        clean: async (category) => {
            if (STORAGE_CLEANABILITY[category] === "none") {
                return "not cleanable";
            }
            if (cleaning !== undefined) {
                return "already cleaning";
            }
            // A scan's sizes would be wrong the moment this starts; the caller scans again once it ends.
            const stopping = scanning?.done.catch(() => undefined);
            cancel();
            const work = (async (): Promise<StorageCleanResult> => {
                await stopping;
                const roots = await resolveStorageRoots(options.workspaceRoot, options.historyRoot);
                return cleanCategory(category, { roots, now, programs: options.programs, prune: options.prune });
            })();
            cleaning = work.catch(() => undefined);
            try {
                const result = await work;
                options.logger.info(result, "storage: cleaned a category");
                return result;
            } finally {
                cleaning = undefined;
            }
        },
    };
};
