import { join } from "node:path";
import { anyNewer, bytesOf, DAY_MS, deleteFiles, gb, GIB, isDir, namesIn, newestSeconds, oldFiles } from "./janitor-fs.js";
import { fleetBusy, type JanitorRun, remove } from "./janitor-run.js";

/* THE SHARED /ci-cache: turbo by age (safe while jobs run, since a reader keeps an unlinked file open), then every other
   entry only while the whole fleet is idle, against its cap; the cargo target dirs by staleness, by their own cap, and
   by a joint cap that takes the least recently built first. */

const TARGET = /-target$/u;
// How deep a target dir is looked into for its newest build: cargo writes its fingerprints three levels down.
const TARGET_DEPTH = 3;

// The cache root's entries as the script's `"$CACHE_ROOT"/*/` globbed them: folders (or links to one), no dot-names.
export const cacheEntries = async (cacheRoot: string): Promise<string[]> => {
    const entries: string[] = [];
    for (const name of (await namesIn(cacheRoot)).filter((entry) => !entry.startsWith("."))) {
        // a stat per entry: a dozen of them
        if (await isDir(join(cacheRoot, name))) {
            entries.push(join(cacheRoot, name));
        }
    }
    return entries;
};

const measure = async (run: JanitorRun, path: string): Promise<number> => {
    const bytes = await bytesOf(path);
    run.measured.set(path, bytes);
    return bytes;
};

/** /ci-cache/turbo over its cap: files older than 3 days go, and older than 1 day only if that was not enough. */
export const cleanTurbo = async (run: JanitorRun): Promise<void> => {
    const turbo = join(run.cacheRoot, "turbo");
    if (!(await isDir(turbo))) {
        return;
    }
    const cap = run.config.turboCapGb;
    for (const days of [3, 1]) {
        // each sweep is measured against what the last left
        const size = await measure(run, turbo);
        if (size <= cap * GIB) {
            break;
        }
        if (run.record.dryRun) {
            run.record.say(`would delete turbo entries older than ${days}d (${gb(size)} GB)`);
            break;
        }
        const old = await oldFiles(turbo, days, run.now);
        await deleteFiles(old.map((file) => file.path));
        const after = await measure(run, turbo);
        run.record.freedBytes += size - after;
        run.record.say(`turbo: deleted entries older than ${days}d, ${gb(size)} -> ${gb(after)} GB`);
    }
};

// One shared entry against its rule: a target dir by staleness, then its cap; anything else by its own cap.
const cleanEntry = async (run: JanitorRun, dir: string, name: string): Promise<void> => {
    const size = await measure(run, dir);
    const { config } = run;
    if (TARGET.test(name)) {
        if (!(await anyNewer(dir, TARGET_DEPTH, run.now - config.targetStaleDays * DAY_MS))) {
            await remove(run, dir, `no build wrote to it in ${config.targetStaleDays} days`);
        } else if (size > config.targetCapGb * GIB) {
            await remove(run, dir, `over the ${config.targetCapGb} GB cap for a cargo target dir`);
        }
        return;
    }
    const cap = config.cacheCaps[name] ?? config.cacheCapGb;
    if (size > cap * GIB) {
        await remove(run, dir, `over its ${cap} GB cap`);
    }
};

interface TargetRow {
    readonly dir: string;
    readonly newest: number;
    readonly bytes: number;
}

// The target dirs that are left, least recently built first (the script's `sort -n` on "<newest> <size> <dir>").
const targetRows = async (run: JanitorRun): Promise<TargetRow[]> => {
    const rows: TargetRow[] = [];
    for (const dir of await cacheEntries(run.cacheRoot)) {
        if (TARGET.test(dir)) {
            // one target dir at a time: each is a walk of its top levels
            rows.push({ dir, newest: await newestSeconds(dir, TARGET_DEPTH), bytes: run.measured.get(dir) ?? (await measure(run, dir)) });
        }
    }
    return rows.toSorted((a, b) => a.newest - b.newest || `${a.bytes} ${a.dir}`.localeCompare(`${b.bytes} ${b.dir}`));
};

// The target dirs, oldest build first, until they fit their joint cap.
const capTargets = async (run: JanitorRun): Promise<void> => {
    const rows = await targetRows(run);
    const cap = run.config.targetsTotalCapGb * GIB;
    let total = rows.reduce((sum, row) => sum + row.bytes, 0);
    for (const row of rows) {
        if (total <= cap) {
            break;
        }
        if (await fleetBusy(run)) {
            run.record.say("target dirs: a job started; stopping here");
            break;
        }
        total -= await remove(run, row.dir, `the target dirs add up to ${gb(total)} GB, over their joint ${run.config.targetsTotalCapGb} GB cap; built least recently`);
    }
};

/** Every shared cache but turbo, only while the whole fleet is idle. */
export const cleanSharedCaches = async (run: JanitorRun): Promise<void> => {
    if (await fleetBusy(run)) {
        run.record.say("shared caches: skipped, a job is running (the next idle pass takes them)");
        return;
    }
    for (const dir of await cacheEntries(run.cacheRoot)) {
        const name = dir.slice(run.cacheRoot.length).replace(/^\/+/u, "");
        if (name === "turbo") {
            continue;
        }
        // one entry at a time, asking before each whether a job started meanwhile
        if (await fleetBusy(run)) {
            run.record.say("shared caches: a job started; stopping here");
            break;
        }
        await cleanEntry(run, dir, name);
    }
    await capTargets(run);
};
