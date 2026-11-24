import { appendFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { CiCache, CiFleetPass } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { Rounds } from "../../device/sandbox-rounds/ic-rounds.js";
import { startRounds } from "../../device/sandbox-rounds/ic-rounds.js";
import { type FleetContext, keptPass } from "../context.js";
import { expandGlob } from "../discover.js";
import { capBuildkit } from "./buildkit.js";
import { bytesOf, diskLine, emptyTrash, gb, GIB, lstatOf, sameFilesystem, type Trash } from "./janitor-fs.js";
import { busyFolders, type JanitorRun, runnerBusy } from "./janitor-run.js";
import { finishPass, newPassRecord } from "./pass-record.js";
import { cleanRunner } from "./runner-cleanup.js";
import { cacheEntries, cleanSharedCaches, cleanTurbo } from "./shared-caches.js";

/* THE JANITOR, fleet-janitor.sh's rules run hourly by the fleet service: it caps what CI jobs leave behind and never
   removes a tagged image, a volume, a checkout or node_modules. A runner's leftovers go only while that runner has no
   Runner.Worker, and the shared /ci-cache entries only while no runner has one; a tree is renamed into the trash before
   it is deleted, so a new job never sees half of it; BuildKit prunes only records no build uses. It runs as root because
   job containers write as root, and the runner, which runs as the person, cannot empty `_temp` after them. A dry run
   (`ci-fleet janitor --dry-run`) says what it would remove and removes nothing. The script's self-update is gone: the
   service updates itself. Each pass goes to the status as `janitor`, with each /ci-cache entry's size as `caches`. */

const JANITOR_EVERY_MS = 60 * 60_000;
// As the timer's OnBootSec: past the burst of jobs a host takes as it comes back.
const JANITOR_FIRST_MS = 20 * 60_000;

// The real folders, for the glob: the janitor removes on the real disk, so it reads it too.
const diskLister = { list: async (path: string) => await readdir(path).catch(undefinedIfMissing) };

const say = async (run: JanitorRun): Promise<void> => {
    const busy = [...(await busyFolders(run))].map((dir) => basename(dir)).toSorted();
    run.record.say(`start: ${await diskLine("/")}; busy runners: ${busy.join(" ")}`);
};

// Every runner folder (one holding a `.runner`) that has no job right now, in the glob's order.
const cleanRunners = async (run: JanitorRun): Promise<void> => {
    for (const dir of await expandGlob(diskLister, run.config.runnersGlob)) {
        // one runner at a time: the busy check before each is what keeps a job's files out of reach
        if ((await lstatOf(join(dir, ".runner")))?.isFile() !== true || (await runnerBusy(run, dir))) {
            continue;
        }
        await cleanRunner(run, dir);
    }
};

// A pass that freed a lot leaves the request wsl-maintenance.ps1 reads (it compacts a disk that is not sparse).
const askForCompaction = async (run: JanitorRun, stateDir: string, freed: number): Promise<void> => {
    if (run.record.dryRun || freed < run.config.compactRequestGb * GIB) {
        return;
    }
    const path = join(stateDir, "compact-requested");
    await appendFile(path, `${new Date(run.now).toISOString()} freed ${gb(freed)} GB\n`);
    run.record.say(`asked the Windows maintenance task to compact the disk (${path})`);
};

// Each /ci-cache entry's size for the status: what this pass measured, the rest measured now.
const cacheSizes = async (run: JanitorRun): Promise<CiCache[]> => {
    const caches: CiCache[] = [];
    for (const dir of await cacheEntries(run.cacheRoot)) {
        // one walk at a time, and only of what the pass did not already measure
        caches.push({ name: basename(dir), bytes: run.measured.get(dir) ?? (await bytesOf(dir)) });
    }
    return caches;
};

const newRun = (context: FleetContext, dryRun: boolean): JanitorRun => {
    const trash: Trash = { dir: join(context.config.stateDir, "trash"), dryRun, serial: 0 };
    return {
        context,
        config: context.config.janitor,
        cacheRoot: context.config.cacheRoot,
        record: newPassRecord(context, "janitor", dryRun),
        trash,
        now: context.sys.now(),
        measured: new Map(),
    };
};

const runPass = async (context: FleetContext, dryRun: boolean): Promise<CiFleetPass> => {
    const run = newRun(context, dryRun);
    await emptyTrash(run.trash);
    // The trash must sit on the same filesystem as what it receives, or every rename is a removal in place.
    if (!(await sameFilesystem(run.trash.dir, run.cacheRoot))) {
        run.record.say(`note: ${run.trash.dir} is not on the same filesystem as ${run.cacheRoot}; removals copy before deleting`);
    }
    await say(run);
    await cleanRunners(run);
    await cleanTurbo(run);
    await cleanSharedCaches(run);
    const dockerFreed = await capBuildkit(run);
    await emptyTrash(run.trash);
    const freed = run.record.freedBytes;
    run.record.say(`done: freed ${gb(freed)} GB on /, ${gb(dockerFreed)} GB of buildkit state; ${await diskLine("/")}`);
    await askForCompaction(run, context.config.stateDir, freed + dockerFreed);
    run.record.freedBytes = freed + dockerFreed;
    const pass = finishPass(context, run.record);
    const caches = await cacheSizes(run);
    await (dryRun ? context.status.update({ caches }) : context.status.update({ janitor: keptPass(pass), caches }));
    return pass;
};

// One pass at a time per service, whoever asks (the hourly round, the socket, the host prune under pressure).
const queues = new WeakMap<FleetContext, Promise<unknown>>();

/** One janitor pass now; a dry run says what it would remove and removes nothing. */
export const runJanitorPass = async (context: FleetContext, options: { readonly dryRun: boolean }): Promise<CiFleetPass> => {
    const before = queues.get(context) ?? Promise.resolve();
    const turn = before.then(
        async () => await runPass(context, options.dryRun),
        async () => await runPass(context, options.dryRun),
    );
    queues.set(
        context,
        turn.catch((_error: Error): undefined => undefined),
    );
    return await turn;
};

export const startJanitor = (context: FleetContext): Rounds => {
    if (!context.config.janitor.enabled) {
        return { stop: () => undefined, running: () => false };
    }
    return startRounds("janitor", context.log, JANITOR_FIRST_MS, () => JANITOR_EVERY_MS, async () => {
        const release = context.busy.hold();
        try {
            await runJanitorPass(context, { dryRun: false });
        } finally {
            release();
        }
    });
};
