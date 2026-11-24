import { readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import type { CiFleetPass } from "@intentic/sandbox-contract/schemas/ci-fleet";
import type { Rounds } from "../../device/sandbox-rounds/ic-rounds.js";
import { startRounds } from "../../device/sandbox-rounds/ic-rounds.js";
import { type FleetContext, keptPass } from "../context.js";
import { expandGlob, readWorkers } from "../discover.js";
import { humanToBytes } from "../janitor/buildkit.js";
import { runJanitorPass } from "../janitor/janitor.js";
import { deleteFiles, diskLine, diskUse, isDir, lstatOf, oldFiles } from "../janitor/janitor-fs.js";
import { finishPass, newPassRecord, type PassRecord } from "../janitor/pass-record.js";
import type { PruneConfig } from "./prune-config.js";
import { CONTAINER_LS_ARGS, ciContainersToRemove } from "./stopped-containers.js";

/* THE HOST PRUNE, linux-host-prune.sh's rules every 15 minutes, on a native Linux CI host whose Docker is its own (z440;
   on omen wsl-maintenance.ps1 does this from Windows, and /ci-cache, runner _temp and buildkit state are the janitor's).
   What no running job can still be using goes every pass. Images, build cache and volumes wait for an idle host, but no
   longer than `forceAfterHours`, and not at all once / is `pressurePercent` full. The host may also run long-lived
   deployments (z440 runs Komodo stacks and Intentic sandboxes), so a compose project's or an Intentic sandbox's
   container, a compose project's network and every named volume but testcontainers' are never touched. A dry run says
   what it would run. Each pass goes to the status as `prune`. */

const PRUNE_EVERY_MS = 15 * 60_000;
// As the timer's OnBootSec.
const PRUNE_FIRST_MS = 10 * 60_000;
const DOCKER_ASK_MS = 20_000;
// A prune on a full disk takes minutes; one that takes longer than this is wedged.
const DOCKER_PRUNE_MS = 30 * 60_000;
const CTR_ASK_MS = 10_000;
const HOUR_MS = 3_600_000;

// What a prune prints when it removed nothing, or the header of the list of what it removed: noise in a journal.
const QUIET = /^(Total reclaimed space: 0B|Total:\s+0B|Deleted (Images|Containers|Networks|Volumes|build cache objects):)$/u;
const RECLAIMED = /^(?:Total reclaimed space:|Total:)\s+(\S+)$/u;

export interface PruneDisk {
    readonly percent: () => Promise<number>;
    readonly line: () => Promise<string>;
}

// The disk the prune guards, `/`; a test hands its own.
const rootDisk: PruneDisk = { percent: async () => (await diskUse("/")).percent, line: async () => await diskLine("/") };

interface PruneRun {
    readonly context: FleetContext;
    readonly config: PruneConfig;
    readonly record: PassRecord;
    readonly disk: PruneDisk;
    readonly now: number;
}

const idle = async (run: PruneRun): Promise<boolean> => (await readWorkers(run.context.sys)).size === 0;

/** One docker command that changes something: said in a dry run, run otherwise, with what it printed (but its noise). */
const docker = async (run: PruneRun, args: readonly string[]): Promise<void> => {
    if (run.record.dryRun) {
        run.record.say(`would run: docker ${args.join(" ")}`);
        return;
    }
    const result = await run.context.sys.run("docker", args, { timeoutMs: DOCKER_PRUNE_MS });
    for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/u).map((text) => text.trimEnd())) {
        if (line.trim() === "" || QUIET.test(line)) {
            continue;
        }
        const reclaimed = RECLAIMED.exec(line)?.[1];
        if (reclaimed !== undefined) {
            run.record.freedBytes += humanToBytes(reclaimed);
        }
        run.record.say(`  ${line}`);
    }
};

/** Whether containerd is writing content for docker right now. "Idle" only knows about CI jobs, but an image prune on
 *  the containerd image store takes the lease of ANY transfer in flight, CI's or not: at 2026-11-17 16:37:45 EST an idle
 *  pass on z440 took the lease of an `ic` sandbox move's 8.7 GB image load, which failed 47 s later ("commit failed:
 *  lease does not exist"). `ctr content active` lists every ingest not yet committed; a host without ctr, or on the
 *  classic image store, has nothing listed there and prunes as before. */
const ingesting = async (run: Pick<PruneRun, "context">): Promise<boolean> => {
    const active = await run.context.sys.run("ctr", ["-n", "moby", "content", "active"], { timeoutMs: CTR_ASK_MS });
    return (
        active.status !== 127 &&
        active.stdout
            .split(/\r?\n/u)
            .slice(1)
            .some((line) => line.trim() !== "")
    );
};

/* -- every pass: nothing a running job can still be using --------------------------------------------------------
   A stopped CI container belongs to no running step; an unused network has no container. Untagged images and build
   cache are NOT safe while a job runs on the containerd image store (z440's): an image being pulled is untagged until
   its last blob lands, and the pass that pruned them at 2026-11-05 17:52:26 EST took a pull's lease and the ingest file
   under it, failing release 1.398.1's core smoke ("failed commit on ref ... rename .../ingest/...: no such file or
   directory"). They go with the full pass below; dockerd's own builder gc (daemon.json) still caps the default
   builder's cache meanwhile. */
const pruneStoppedContainers = async (run: PruneRun): Promise<void> => {
    const listed = await run.context.sys.run("docker", CONTAINER_LS_ARGS, { timeoutMs: DOCKER_ASK_MS * 3 });
    const ids = ciContainersToRemove(listed.status === 0 ? listed.stdout : "", run.now);
    if (ids.length > 0) {
        await docker(run, ["container", "rm", ...ids]);
    }
};

// Runner _diag logs older than `diagDays`, in every runner folder.
const pruneRunnerLogs = async (run: PruneRun): Promise<void> => {
    const days = run.config.diagDays;
    const lister = { list: async (path: string) => await readdir(path).catch(undefinedIfMissing) };
    for (const dir of await expandGlob(lister, run.context.config.janitor.runnersGlob)) {
        const diag = join(dir, "_diag");
        // one runner at a time: a few hundred files each
        if (!(await isDir(diag))) {
            continue;
        }
        const old = await oldFiles(diag, days, run.now, (name) => name.endsWith(".log"));
        if (run.record.dryRun) {
            if (old.length > 0) {
                run.record.say(`would remove ${old.length} runner logs older than ${days}d in ${diag}`);
            }
            continue;
        }
        await deleteFiles(old.map((file) => file.path));
        run.record.freedBytes += old.reduce((sum, file) => sum + file.bytes, 0);
    }
};

// setup-linux-runner.sh downloads one tarball per runner version; the newest is kept.
const pruneRunnerTarballs = async (run: PruneRun): Promise<void> => {
    const cache = run.config.runnerCache;
    const names = ((await readdir(cache).catch(undefinedIfMissing)) ?? []).filter((name) => /^actions-runner-linux-.*\.tar\.gz$/u.test(name));
    const dated = await Promise.all(names.map(async (name) => ({ path: join(cache, name), stats: await lstatOf(join(cache, name)) })));
    const newestFirst = dated.filter((entry) => entry.stats !== undefined).toSorted((a, b) => (b.stats?.mtimeMs ?? 0) - (a.stats?.mtimeMs ?? 0));
    for (const { path, stats } of newestFirst.slice(1)) {
        if (run.record.dryRun) {
            run.record.say(`would run: rm -f -- ${path}`);
            continue;
        }
        // one small unlink each
        await rm(path, { force: true });
        run.record.freedBytes += stats?.size ?? 0;
        run.record.say(`removed ${path}: a runner tarball a newer one superseded`);
    }
};

export type FullPassMode = "pressure" | "idle" | "overdue";

/** Whether this pass takes images, build cache and volumes, and why: a disk past its pressure line at once, else an idle
 *  host, else one that has gone `forceAfterHours` without a full pass. */
export const fullPassMode = (used: number, isIdle: boolean, sinceHours: number, config: PruneConfig): FullPassMode | undefined => {
    if (used >= config.pressurePercent) {
        return "pressure";
    }
    if (isIdle) {
        return "idle";
    }
    return sinceHours >= config.forceAfterHours ? "overdue" : undefined;
};

const stampPath = (run: PruneRun): string => join(run.context.config.stateDir, "prune-full-at");

const pruneImagesAndCache = async (run: PruneRun, mode: FullPassMode): Promise<void> => {
    if (mode !== "pressure" && (await ingesting(run))) {
        run.record.say("images and build cache: left for the next pass, docker is writing an image (a pull, load or build)");
        return;
    }
    await docker(run, ["image", "prune", "-f", "--filter", "until=1h"]);
    await docker(run, ["builder", "prune", "-f", "--max-used-space", run.config.buildCacheMax]);
    if (mode === "pressure") {
        await docker(run, ["image", "prune", "-af"]);
        await docker(run, ["builder", "prune", "-af"]);
    } else {
        await docker(run, ["image", "prune", "-af", "--filter", `until=${run.config.imageAge}`]);
    }
};

// Still past the pressure line after docker gave what it could: the janitor takes /ci-cache now, not at its next hour.
const callTheJanitor = async (run: PruneRun): Promise<void> => {
    const used = await run.disk.percent();
    if (used < run.config.pressurePercent) {
        return;
    }
    run.record.say(`still ${used}% used after pruning docker; starting the janitor for /ci-cache`);
    if (run.record.dryRun) {
        return;
    }
    const { context } = run;
    const release = context.busy.hold();
    void runJanitorPass(context, { dryRun: false })
        .catch((error: Error) => context.log(`prune: the janitor it started failed: ${errorMessage(error)}`))
        .finally(release);
};

/* -- full pass: tagged images and volumes --------------------------------------------------------------------------
   A job pulls its image and creates its container a moment later, and between the two nothing marks the image as used,
   so these wait for no job to be running. Overdue and pressure passes take that small risk on purpose: one job failing
   at "Initialize containers" is cheaper than a full disk failing all of them. */
const fullPass = async (run: PruneRun): Promise<void> => {
    const used = await run.disk.percent();
    const last = (await stat(stampPath(run)).catch(undefinedIfMissing))?.mtimeMs ?? 0;
    const sinceHours = Math.floor((run.now - last) / HOUR_MS);
    const mode = fullPassMode(used, await idle(run), sinceHours, run.config);
    if (mode === undefined) {
        run.record.say(`full pass: waiting for an idle moment (last one ${sinceHours}h ago, forced at ${run.config.forceAfterHours}h)`);
        return;
    }
    run.record.say(`full pass (${mode})`);
    await pruneImagesAndCache(run, mode);
    // Anonymous volumes, and of the named ones only what testcontainers made. Never -a over everything: a named volume
    // is unreferenced whenever its stack's container is gone, and it holds that deployment's data (a sandbox's
    // intentic-* volumes, a compose project's). The intentic-cache builder's state is named, and kept either way.
    await docker(run, ["volume", "prune", "-f"]);
    await docker(run, ["volume", "prune", "-af", "--filter", "label=org.testcontainers=true"]);
    if (!run.record.dryRun) {
        await writeFile(stampPath(run), "");
        await utimes(stampPath(run), run.now / 1000, run.now / 1000);
    }
    if (mode === "pressure") {
        await callTheJanitor(run);
    }
};

// A daemon.json change setup-linux-runner.sh left for an idle moment. A restart stops every container that live-restore
// does not keep, so only with no job running.
const restartDockerIfAsked = async (run: PruneRun): Promise<void> => {
    const flag = join(run.context.config.stateDir, "docker-restart-pending");
    if (run.record.dryRun || (await lstatOf(flag)) === undefined || !(await idle(run))) {
        return;
    }
    run.record.say("restarting docker for its new daemon.json");
    await rm(flag, { force: true });
    if ((await run.context.sys.run("systemctl", ["restart", "docker"], { timeoutMs: 5 * 60_000 })).status !== 0) {
        run.record.say("docker did not restart cleanly; journalctl -u docker");
    }
};

const prunePass = async (run: PruneRun): Promise<void> => {
    const jobs = (await readWorkers(run.context.sys)).size;
    run.record.say(`start: ${await run.disk.percent()}% of / used; ${jobs === 0 ? "no job running" : `jobs running: ${jobs}`}`);
    if ((await run.context.sys.run("docker", ["version"], { timeoutMs: DOCKER_ASK_MS })).status !== 0) {
        run.record.say("docker is not answering; nothing pruned");
        return;
    }
    await pruneStoppedContainers(run);
    await docker(run, ["network", "prune", "-f", "--filter", "until=24h", "--filter", "label!=com.docker.compose.project"]);
    await pruneRunnerLogs(run);
    await pruneRunnerTarballs(run);
    await fullPass(run);
    await restartDockerIfAsked(run);
    run.record.say(`done: ${await run.disk.line()}`);
};

/** One host prune pass now; a dry run says what it would run. Refused where the prune is off. */
export const runPrunePass = async (context: FleetContext, options: { readonly dryRun: boolean; readonly disk?: PruneDisk }): Promise<CiFleetPass> => {
    if (!context.config.prune.enabled) {
        throw new Error("The host prune is off on this computer (its Docker is pruned from Windows, or was never handed to it): `ci-fleet install --prune` turns it on.");
    }
    const run: PruneRun = { context, config: context.config.prune, record: newPassRecord(context, "prune", options.dryRun), disk: options.disk ?? rootDisk, now: context.sys.now() };
    await prunePass(run);
    const pass = finishPass(context, run.record);
    if (!options.dryRun) {
        await context.status.update({ prune: keptPass(pass) });
    }
    return pass;
};

export const startPrune = (context: FleetContext): Rounds => {
    if (!context.config.prune.enabled) {
        return { stop: () => undefined, running: () => false };
    }
    return startRounds("prune", context.log, PRUNE_FIRST_MS, () => PRUNE_EVERY_MS, async () => {
        const release = context.busy.hold();
        try {
            await runPrunePass(context, { dryRun: false });
        } finally {
            release();
        }
    });
};
