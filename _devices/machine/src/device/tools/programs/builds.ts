import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isInside } from "@intentic/base/contained";
import { undefinedIfMissing } from "@intentic/base/errors";
import { readTextIfExists } from "@intentic/base/fs";
import { parseJsonWith } from "@intentic/base/json";
import { z } from "zod";

/* HOW LONG A PUSHED BUILD STAYS (2026-11-12). Every `devices push` and `devices run` files its build once, under
   `runs/<sandbox>/<name>/<first 12 of its sha256>/` (artifacts.ts), and nothing ever removed one: omen held 102 GB there
   on 2026-11-12, 94 builds of one server and 33 of its 2.4 GB asset folder, pushed over four days. A name keeps its
   newest BUILDS_KEPT builds for BUILD_KEEP_MS; the rest go once they are BUILD_GRACE_MS old. A build any program
   apps.json holds as running starts from, reads or works in is never touched, whatever its age. A pruned build costs
   only a push: `devices run` asks whether the build is here and sends it again when it is not. */

// The folder's marker: a build is "there" once this is in it (artifacts.ts writes it last).
export const COMPLETE = ".intentic-complete";
export const BUILDS_KEPT = 3;
export const BUILD_KEEP_MS = 30 * 24 * 60 * 60_000;
// A build just filed may be one a run is about to start from, with newer ones of its name filed in the meantime.
export const BUILD_GRACE_MS = 60 * 60_000;
// A folder with no marker is a filing that died; one this old is not one still unpacking.
export const HALF_FILED_MS = 24 * 60 * 60_000;
// A build folder's name: the first 12 hex characters of what was sent. Anything else under a name is not ours to prune.
const VERSION = /^[0-9a-f]{12}$/;

export interface FiledBuild {
    readonly name: string;
    readonly dir: string;
    // When it was filed (its marker's time), or, for a half-filed folder, when the folder last changed.
    readonly at: number;
    readonly complete: boolean;
}

// The builds to delete, per name: past the newest BUILDS_KEPT or past BUILD_KEEP_MS, never one younger than the grace or
// one `inUse` names, and half-filed folders a day old. Pure over the listing.
export const expiredBuilds = (builds: readonly FiledBuild[], inUse: (dir: string) => boolean, now: number): FiledBuild[] => {
    const expired: FiledBuild[] = [];
    for (const name of new Set(builds.map((build) => build.name))) {
        const own = builds.filter((build) => build.name === name && !inUse(build.dir));
        const newestFirst = own.filter((build) => build.complete).toSorted((a, b) => b.at - a.at);
        for (const [index, build] of newestFirst.entries()) {
            const age = now - build.at;
            if (age >= BUILD_GRACE_MS && (index >= BUILDS_KEPT || age >= BUILD_KEEP_MS)) {
                expired.push(build);
            }
        }
        expired.push(...own.filter((build) => !build.complete && now - build.at >= HALF_FILED_MS));
    }
    return expired;
};

// Every build folder under one sandbox's runs folder (or under one name of it), with when it was filed.
const filedBuilds = async (sandboxDir: string, only?: string): Promise<FiledBuild[]> => {
    // No folder is a sandbox that never pushed here. Only folders hold builds: apps.json is a file.
    const listed = only === undefined ? ((await readdir(sandboxDir, { withFileTypes: true }).catch(undefinedIfMissing)) ?? []) : [];
    const names = only === undefined ? listed.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name) : [only];
    const found: FiledBuild[] = [];
    for (const name of names) {
        // A name gone since the listing holds no builds.
        const versions = (await readdir(join(sandboxDir, name), { withFileTypes: true }).catch(undefinedIfMissing)) ?? [];
        for (const version of versions) {
            if (!version.isDirectory() || !VERSION.test(version.name)) {
                continue;
            }
            const dir = join(sandboxDir, name, version.name);
            const marker = await stat(join(dir, COMPLETE)).catch(undefinedIfMissing);
            const folder = marker ?? (await stat(dir).catch(undefinedIfMissing));
            if (folder !== undefined) {
                found.push({ name, dir, at: folder.mtimeMs, complete: marker !== undefined });
            }
        }
    }
    return found;
};

// What apps.json says of a run, as far as this reads it (programs.ts writes the whole AppRun).
const RunPathsSchema = z.array(
    z.object({ program: z.string().optional(), cwd: z.string().optional(), args: z.array(z.string()).optional(), endedAt: z.string().optional() }).loose(),
);

// Every path a running program of this sandbox was started with: its program, its working folder and its arguments.
// A record that does not read protects nothing, so undefined, and the caller prunes nothing of that sandbox.
const runningPaths = async (sandboxDir: string): Promise<readonly string[] | undefined> => {
    // No record at all is a sandbox that never started a program here.
    const runs = parseJsonWith((await readTextIfExists(join(sandboxDir, "apps.json"))) ?? "[]", RunPathsSchema);
    return runs
        ?.filter((run) => run.endedAt === undefined)
        .flatMap((run) => [run.program, run.cwd, ...(run.args ?? [])])
        .filter((path): path is string => path !== undefined && path !== "");
};

// The builds of one sandbox (or one name of it) to delete now.
export const buildsToPrune = async (sandboxDir: string, now: number, only?: string): Promise<FiledBuild[]> => {
    const running = await runningPaths(sandboxDir);
    if (running === undefined) {
        return [];
    }
    // Windows paths compare without case: apps.json may spell the folder as the program was started with it.
    const foldCase = process.platform === "win32";
    const inUse = (dir: string): boolean => running.some((path) => isInside(dir, path, { foldCase }));
    return expiredBuilds(await filedBuilds(sandboxDir, only), inUse, now);
};

// After a build is filed: the older ones of its name that are past their keeping. Upkeep's pass catches anything this
// misses; a build a running program still holds (a Windows .exe) fails to go and is tried again there.
export const pruneAfterFiling = async (sandboxDir: string, name: string, now: number): Promise<void> => {
    for (const build of await buildsToPrune(sandboxDir, now, name)) {
        // allow(silent-catch): a build that will not go now is the upkeep pass's to retry
        await rm(build.dir, { recursive: true, force: true }).catch(() => undefined);
    }
};
