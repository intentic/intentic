import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import {
    STORAGE_CLEANABILITY,
    type StorageCategoryId,
    type StorageCategoryUsage,
    type StorageCleanResult,
    type StorageReport,
    type StorageScan,
} from "@intentic/sandbox-contract";

// What the demo box's disk holds, for the Overview's Disk card: the same 100 GiB volume the geek metrics read, most of
// it the shop's own files and the agents' checkouts. A clean takes what its category could free and a later scan no
// longer counts it, so the card's whole loop (scan, confirm, freed, scan again) can be walked without a disk.

const GIB = 2 ** 30;
const MIB = 2 ** 20;

const STATE = `${WORKSPACE_ROOT}/${STATE_DIR}`;

interface DemoCategory {
    readonly bytes: number;
    readonly files: number;
    // What a clean would free now; absent where the daemon cannot promise a figure (a package store).
    readonly cleanable?: number;
    readonly items: readonly (readonly [path: string, bytes: number])[];
}

const DEMO_DISK: Readonly<Partial<Record<StorageCategoryId, DemoCategory>>> = {
    workspace: {
        bytes: 14.2 * GIB,
        files: 212_000,
        items: [
            [`${WORKSPACE_ROOT}/shop`, 9.1 * GIB],
            [`${WORKSPACE_ROOT}/api`, 3.4 * GIB],
            [`${WORKSPACE_ROOT}/infra`, 1.2 * GIB],
            [`${WORKSPACE_ROOT}/docs`, 0.5 * GIB],
        ],
    },
    checkouts: {
        bytes: 8.6 * GIB,
        files: 188_000,
        items: [
            [`${HISTORY_ROOT}/worktrees/checkout-stripe`, 2.1 * GIB],
            [`${HISTORY_ROOT}/overlays/checkout-stripe`, 1.4 * GIB],
            [`${HISTORY_ROOT}/worktrees/fix-cart-rounding`, 1.9 * GIB],
            [`${HISTORY_ROOT}/worktrees/search-facets`, 1.8 * GIB],
        ],
    },
    packageStores: {
        bytes: 5.3 * GIB,
        files: 83_000,
        items: [
            [`${HISTORY_ROOT}/.pnpm-store`, 4.1 * GIB],
            [`${WORKSPACE_ROOT}/.pnpm-store`, 1.2 * GIB],
        ],
    },
    conversations: {
        bytes: 3.1 * GIB,
        files: 14_000,
        items: [
            [`${STATE}/records/sessions/claude`, 2.4 * GIB],
            [`${HISTORY_ROOT}/conversations`, 0.6 * GIB],
            [`${STATE}/records/artifacts/attachments`, 0.1 * GIB],
        ],
    },
    engines: {
        bytes: 2.2 * GIB,
        files: 16_000,
        items: [
            [`${HISTORY_ROOT}/engines/codex`, 0.8 * GIB],
            [`${HISTORY_ROOT}/engines/opencode`, 0.7 * GIB],
            [`${HISTORY_ROOT}/engines/claude`, 0.5 * GIB],
            [`${HISTORY_ROOT}/engines/cursor`, 0.2 * GIB],
        ],
    },
    restorePoints: {
        bytes: 1.6 * GIB,
        files: 16_000,
        items: [
            [`${HISTORY_ROOT}/scopes/shop.git`, 0.9 * GIB],
            [`${HISTORY_ROOT}/scopes/api.git`, 0.5 * GIB],
            [`${HISTORY_ROOT}/scopes/root.git`, 0.2 * GIB],
        ],
    },
    modelWeights: {
        bytes: 1.3 * GIB,
        files: 1,
        cleanable: 1.3 * GIB,
        items: [[`${STATE}/local/cache/models/Qwen3.5-2B-Q4_K_M.gguf`, 1.3 * GIB]],
    },
    browserCaptures: {
        bytes: 1.1 * GIB,
        files: 6_700,
        cleanable: 1.0 * GIB,
        items: [
            [`${STATE}/records/artifacts/browser/checkout-flow`, 0.4 * GIB],
            [`${STATE}/records/artifacts/browser/mobile-audit`, 0.3 * GIB],
            [`${STATE}/records/artifacts/browser/page-2026-09-22.png`, 2 * MIB],
        ],
    },
    trash: {
        bytes: 0.9 * GIB,
        files: 4_300,
        cleanable: 0.9 * GIB,
        items: [
            [`${HISTORY_ROOT}/trash/legacy-admin-1789157840134`, 0.7 * GIB],
            [`${HISTORY_ROOT}/trash/storefront-v1-1789157842097`, 0.2 * GIB],
        ],
    },
    repositories: {
        bytes: 0.8 * GIB,
        files: 1_700,
        items: [
            [`${HISTORY_ROOT}/gits/shop`, 0.5 * GIB],
            [`${HISTORY_ROOT}/gits/api`, 0.25 * GIB],
            [`${HISTORY_ROOT}/gits/root`, 0.05 * GIB],
        ],
    },
    indexes: {
        bytes: 0.7 * GIB,
        files: 300,
        items: [
            [`${STATE}/local/cache/iq`, 0.45 * GIB],
            [`${HISTORY_ROOT}/said-index`, 0.2 * GIB],
        ],
    },
    logs: {
        bytes: 250 * MIB,
        files: 100,
        cleanable: 180 * MIB,
        items: [
            [`${HISTORY_ROOT}/logs/terminals`, 160 * MIB],
            [`${HISTORY_ROOT}/logs/resource-metrics.jsonl`, 40 * MIB],
            [`${HISTORY_ROOT}/logs/daemon.log`, 12 * MIB],
        ],
    },
    browserProfiles: {
        bytes: 140 * MIB,
        files: 2_600,
        cleanable: 60 * MIB,
        items: [
            [`${STATE}/local/browser/stripe-dashboard`, 70 * MIB],
            [`${STATE}/local/browser/shopify-admin`, 60 * MIB],
        ],
    },
    // Everything here was written this morning: a clean would leave it all, which the card says rather than offers.
    scratch: {
        bytes: 120 * MIB,
        files: 15,
        cleanable: 0,
        items: [[`${STATE}/local/verify/shop--verify.log`, 110 * MIB]],
    },
    state: { bytes: 20 * MIB, files: 120, items: [[`${HISTORY_ROOT}/activity.jsonl`, 5 * MIB]] },
};

// What a package store's prune gives back on the demo box: the tool decides, so the figure only exists afterwards.
const PRUNED_STORE_BYTES = 3.2 * GIB;

const cleaned = new Set<StorageCategoryId>();

const usageOf = (id: StorageCategoryId, category: DemoCategory): StorageCategoryUsage => {
    const gone = cleaned.has(id) ? (category.cleanable ?? PRUNED_STORE_BYTES) : 0;
    const cleanable = category.cleanable === undefined ? undefined : cleaned.has(id) ? 0 : category.cleanable;
    return {
        id,
        cleanability: STORAGE_CLEANABILITY[id],
        bytes: Math.round(category.bytes - gone),
        files: category.files,
        ...(cleanable === undefined ? {} : { cleanableBytes: Math.round(cleanable) }),
        items: category.items.map(([path, bytes]) => ({ path, bytes: Math.round(cleaned.has(id) ? 0 : bytes) })).filter((item) => item.bytes > 0),
    };
};

const scanAt = (finishedAt: number): StorageScan => {
    const categories = (Object.entries(DEMO_DISK) as [StorageCategoryId, DemoCategory][])
        .map(([id, category]) => usageOf(id, category))
        .filter((category) => category.bytes > 0)
        .toSorted((left, right) => right.bytes - left.bytes);
    const counted = categories.reduce((total, category) => total + category.bytes, 0);
    return {
        startedAt: finishedAt - 14_000,
        finishedAt,
        outcome: `complete`,
        // What the scan counts plus the system's own share, on the volume the geek metrics report.
        disk: { usedBytes: Math.round(counted + 1.6 * GIB), totalBytes: 100 * GIB },
        categories,
        unreadable: 0,
    };
};

// Measured a quarter of an hour before the demo opened, so the card reads as a box somebody already looked at.
let last = scanAt(Date.now() - 15 * 60_000);

export const demoStorageReport = (): StorageReport => ({ scan: last, scanning: false });

export const demoStorageScan = (now: number): StorageReport => {
    last = scanAt(now);
    return demoStorageReport();
};

export const demoStorageClean = (id: StorageCategoryId): StorageCleanResult => {
    const category = DEMO_DISK[id];
    const freed = category === undefined || cleaned.has(id) ? 0 : (category.cleanable ?? PRUNED_STORE_BYTES);
    cleaned.add(id);
    return { category: id, freedBytes: Math.round(freed), removed: freed > 0 ? (category?.items.length ?? 0) : 0, kept: 0, failed: 0 };
};
