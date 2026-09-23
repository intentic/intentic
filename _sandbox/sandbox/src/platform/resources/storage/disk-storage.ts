import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { STORAGE_CLEANABILITY, type StorageCategoryId, type StorageCleanResult, type StorageReport, type StorageScan } from "@intentic/sandbox-contract";
import { FLY_VOLUME_LAYOUT, FLY_VOLUME_PATH } from "@intentic/sandbox-run/fly";
import type { Logger } from "pino";
import { cleanCategory } from "./storage-clean.js";
import type { StorageRoots } from "./storage-catalog.js";
import { scanStorage } from "./storage-scan.js";
import { isAbortError } from "./storage-walk.js";
import type { RunningProgram } from "./running-programs.js";

// The one scan a daemon runs at a time, the last one it finished, and the one clean it runs at a time. Held in memory
// only: a scan is minutes of disk reads at most, and a restart that forgets it costs one more.

// Long enough for a million files on a busy volume; a scan that runs out answers `partial` rather than never.
const SCAN_BUDGET_MS = 120_000;

export interface DiskStorage {
    readonly report: () => StorageReport;
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

export const createDiskStorage = (options: DiskStorageOptions): DiskStorage => {
    const now = options.now ?? Date.now;
    let last: StorageScan | undefined;
    let scanning: { readonly controller: AbortController; readonly done: Promise<StorageReport> } | undefined;
    let cleaning: Promise<unknown> | undefined;

    const report = (): StorageReport => ({ ...(last === undefined ? {} : { scan: last }), scanning: scanning !== undefined });

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
