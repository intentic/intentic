import { isAbsolute, join } from "node:path";
import { readTextIfExists } from "@intentic/base/fs";
import { parseRunnerFile } from "../discover.js";
import { repackCheckouts } from "./git-repack.js";
import { anyNewer, bytesOf, DAY_MS, deleteFilesAndEmptyDirs, gb, GIB, isDir, lstatOf, namesIn, oldFiles, resolved } from "./janitor-fs.js";
import { type JanitorRun, remove, runnerBusy, wouldOr } from "./janitor-run.js";

/* ONE RUNNER'S LEFTOVERS, taken only while that runner is idle (the pass skips a busy one whole, and each removal asks
   again): the job's `_temp`, the runner's own old logs, runner versions a self-update superseded, a stale self-update
   download, an oversized per-runner pnpm store, and checkouts with too many packs. */

// A `_temp` entry younger than this may be a job's that started since the runner was found idle: it creates its entries fresh.
const TEMP_SETTLE_MS = 10 * 60_000;

/** The runner's work folder, as its `.runner` names it (`_work` unless it says otherwise), relative to the runner. */
const workFolder = async (dir: string): Promise<string> => {
    const text = await readTextIfExists(join(dir, ".runner"));
    const named = text === undefined ? undefined : parseRunnerFile(text)?.workFolder;
    const folder = named === undefined || named === "" ? "_work" : named;
    return isAbsolute(folder) ? folder : join(dir, folder);
};

// `find _temp -mindepth 1 -maxdepth 1 ! -name _github_home -mmin +10`, then the job's $HOME (`_github_home`) whole but
// its `.docker`, which names the intentic-cache builder publish-images.sh reuses.
const tempEntries = async (temp: string, now: number): Promise<string[]> => {
    const entries: string[] = [];
    for (const name of await namesIn(temp)) {
        const stats = name === "_github_home" ? undefined : await lstatOf(join(temp, name));
        if (stats !== undefined && now - stats.mtimeMs > TEMP_SETTLE_MS) {
            entries.push(join(temp, name));
        }
    }
    const home = join(temp, "_github_home");
    if (await isDir(home)) {
        entries.push(
            ...(await namesIn(home))
                .filter((name) => name !== ".docker")
                .map((name) => join(home, name)),
        );
    }
    return entries;
};

const cleanTemp = async (run: JanitorRun, dir: string, work: string): Promise<void> => {
    const temp = join(work, "_temp");
    if (!(await isDir(temp))) {
        return;
    }
    let count = 0;
    let total = 0;
    for (const entry of await tempEntries(temp, run.now)) {
        // one entry at a time, asking before each whether a job took the runner meanwhile
        if (await runnerBusy(run, dir)) {
            break;
        }
        total += await remove(run, entry);
        count += 1;
    }
    if (count > 0) {
        run.record.say(`${wouldOr(run, "removed")} ${count} entries (${gb(total)} GB) a finished job left in ${temp}`);
    }
};

// The runner's own logs: by age, safe while it works (the logs it is writing are today's).
const cleanDiag = async (run: JanitorRun, dir: string): Promise<void> => {
    const diag = join(dir, "_diag");
    if (!(await isDir(diag))) {
        return;
    }
    const days = run.config.diagDays;
    const old = await oldFiles(diag, days, run.now);
    if (run.record.dryRun) {
        if (old.length > 0) {
            run.record.say(`would remove ${old.length} runner log files older than ${days}d in ${diag}`);
        }
        return;
    }
    const size = old.reduce((sum, file) => sum + file.bytes, 0);
    if (size > 0) {
        await deleteFilesAndEmptyDirs(
            diag,
            old.map((file) => file.path),
        );
        run.record.freedBytes += size;
        run.record.say(`removed ${gb(size)} GB of runner logs older than ${days}d in ${diag}`);
    }
};

// A `<kind>.<version>` folder the `<kind>` link no longer points at; only while the link resolves to a folder, so a
// runner mid-update, or laid out some other way, is left alone.
const supersededOf = async (dir: string, kind: string): Promise<string[]> => {
    const link = join(dir, kind);
    const current = await resolved(link);
    if (current === undefined || !(await isDir(current)) || (await lstatOf(link))?.isSymbolicLink() !== true) {
        return [];
    }
    const old: string[] = [];
    for (const name of (await namesIn(dir)).filter((entry) => entry.startsWith(`${kind}.`))) {
        const path = join(dir, name);
        // a real folder, not a link, and not the one in use
        if ((await lstatOf(path))?.isDirectory() === true && (await resolved(path)) !== current) {
            old.push(path);
        }
    }
    return old;
};

// Superseded runner versions: a self-update installs bin.<version> and externals.<version> and points the bin and
// externals links at them, keeping every older one (1.4 GB a runner after two updates).
const cleanVersions = async (run: JanitorRun, dir: string): Promise<void> => {
    for (const kind of ["bin", "externals"]) {
        for (const old of await supersededOf(dir, kind)) {
            // one version at a time, asking before each whether a job took the runner meanwhile
            if (await runnerBusy(run, dir)) {
                break;
            }
            await remove(run, old, `a runner version the ${kind} link no longer points at`);
        }
    }
};

// A runner's self-update leaves its download in <work>/_update; nothing in it written for a day is not an update running.
const cleanUpdate = async (run: JanitorRun, dir: string, work: string): Promise<void> => {
    const update = join(work, "_update");
    const days = run.config.updateStaleDays;
    if ((await isDir(update)) && !(await anyNewer(update, 1, run.now - days * DAY_MS)) && !(await runnerBusy(run, dir))) {
        await remove(run, update, `a runner self-update's download, finished more than ${days}d ago`);
    }
};

const cleanStore = async (run: JanitorRun, dir: string, work: string): Promise<void> => {
    const store = join(work, ".pnpm-store");
    if (!(await isDir(store))) {
        return;
    }
    const cap = run.config.workspaceStoreCapGb;
    if ((await bytesOf(store)) > cap * GIB && !(await runnerBusy(run, dir))) {
        await remove(run, store, `over the ${cap} GB cap for a per-runner pnpm store`);
    }
};

/** Every rule for one idle runner, in the script's order. */
export const cleanRunner = async (run: JanitorRun, dir: string): Promise<void> => {
    const work = await workFolder(dir);
    await cleanTemp(run, dir, work);
    await cleanDiag(run, dir);
    await cleanVersions(run, dir);
    await cleanUpdate(run, dir, work);
    await cleanStore(run, dir, work);
    await repackCheckouts(run, dir, work);
};
