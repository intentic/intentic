import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { GIB } from "../../../system/resources/storage/checkout-space.js";
import { walkTree } from "../../../system/resources/storage/storage-walk.js";
import { findBuildOutputs } from "./build-outputs.js";

// WHAT A CHECKOUT GROWS TO, NOT WHAT IT STARTS AS (2026-11-03). Admission sized a new checkout by its tracked files:
// shinobi's was about 0.3 GB, and each one went on to build a Rust `target/` of 8-23 GB (median 7.8) that admission
// never saw, so it kept saying yes until the disk was full. A repository's build output is now part of its price: what
// main's own checkout of it holds in build output, measured in the background and kept for hours, since a `target/`
// moves by gigabytes a day, not a minute. Until a measurement lands, or where main has never been built, a repository
// with a Cargo manifest near its top is priced at RUST_TARGET_ESTIMATE, the median shinobi measured; anything else at
// nothing, as before.

export const RUST_TARGET_ESTIMATE = 8 * GIB;

// THE MOST ONE CHECKOUT IS PRICED AT (2026-11-12). Main's own target/ is every build it ever ran, piled up: on shinobi
// 93 GB (68 of it Cargo's incremental caches across seven build profiles), and every new checkout was priced at all of
// it, so a disk with 127 GB free turned sessions away. A checkout builds what its one task needs: shinobi's measured
// 8-23 GB. Main's measure still counts below this; above it, the checkout is priced at the most one was seen to reach.
export const BUILD_OUTPUT_PRICE_CAP = 24 * GIB;

// A measurement stands this long; the next ask after it starts a new one and answers with the old meanwhile.
const MEASURE_EVERY_MS = 6 * 60 * 60 * 1000;
// One measurement's walk is bounded: a partial size is still a floor of what a checkout grows to.
const MEASURE_BUDGET_MS = 60_000;
// Folders read at once by the walk; half the storage scan's, since this runs beside turns.
const MEASURE_CONCURRENCY = 4;

interface Measured {
    readonly bytes: number;
    readonly at: number;
}

const measured = new Map<string, Measured>();
const measuring = new Map<string, Promise<void>>();

// A Cargo manifest at the repository's top or one folder below it: a workspace root, or a crate dir beside others.
const hasCargoManifest = async (dir: string): Promise<boolean> => {
    const entries: Dirent[] = (await readdir(dir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
    if (entries.some((entry) => entry.isFile() && entry.name === "Cargo.toml")) {
        return true;
    }
    for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules") {
            const below: string[] = (await readdir(join(dir, entry.name)).catch(undefinedIfMissing)) ?? [];
            if (below.includes("Cargo.toml")) {
                return true;
            }
        }
    }
    return false;
};

export const measureBuildOutputs = async (dir: string, budgetMs = MEASURE_BUDGET_MS): Promise<number> => {
    let bytes = 0;
    const deadline = Date.now() + budgetMs;
    for (const output of await findBuildOutputs(dir)) {
        await walkTree(output, undefined, { folder: () => undefined, file: (file) => void (bytes += file.size) }, { deadline, concurrency: MEASURE_CONCURRENCY });
    }
    return bytes;
};

export interface EstimateOptions {
    readonly now?: number;
    readonly measure?: (dir: string) => Promise<number>;
}

// What a checkout of the repository at `dir` (main's own) is expected to add in build output. Never waits on a walk.
// Only a Cargo repository is priced: one whose crates sit deeper (a monorepo with a Rust tool in a corner) mostly
// never builds them in a conversation, and main's own build of that corner says nothing of what a checkout will do.
export const buildOutputEstimate = async (dir: string, options: EstimateOptions = {}): Promise<number> => {
    if (!(await hasCargoManifest(dir))) {
        return 0;
    }
    const now = options.now ?? Date.now();
    const known = measured.get(dir);
    if ((known === undefined || now - known.at >= MEASURE_EVERY_MS) && !measuring.has(dir)) {
        const run = (options.measure ?? measureBuildOutputs)(dir)
            .then((bytes) => void measured.set(dir, { bytes, at: now }))
            // allow(silent-catch): an unmeasurable tree keeps the last size or the estimate; the next ask measures again.
            .catch(() => undefined)
            .finally(() => measuring.delete(dir));
        measuring.set(dir, run);
    }
    // Main never built, or built nothing yet: the median a Rust checkout grew to.
    return known === undefined || known.bytes === 0 ? RUST_TARGET_ESTIMATE : Math.min(known.bytes, BUILD_OUTPUT_PRICE_CAP);
};

// The measurement in flight for `dir`, for a test to wait on.
export const settledEstimate = (dir: string): Promise<void> => measuring.get(dir) ?? Promise.resolve();
