import { existsSync, mkdirSync, readdirSync, readFileSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec, type FakeRunner, fakeSys, runnerPrograms, tempDir, testConfig, testContext } from "../ci-fleet-testing.js";
import { JanitorConfigSchema } from "./janitor-config.js";
import { buildctlTotal, humanToBytes } from "./buildkit.js";
import { runJanitorPass } from "./janitor.js";

/* The janitor on real temp folders, with systemd, pgrep, git and docker faked: what it removes, what it leaves, and that
   every rule fleet-janitor.sh gated on an idle runner or an idle fleet still is. Sizes are sparse files, which du -b
   and the janitor both count by their apparent size, so a "7 GB" store costs nothing. */

const NOW = Date.parse("2026-11-24T12:00:00Z");
const DAY = 86_400_000;
const GIB = 1024 ** 3;

// A file of `bytes` (sparse) written `ageMs` before NOW; its folders are made as needed.
const file = (path: string, bytes = 10, ageMs = 0): string => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "");
    truncateSync(path, bytes);
    age(path, ageMs);
    return path;
};
const age = (path: string, ageMs: number): void => {
    const at = (NOW - ageMs) / 1000;
    utimesSync(path, at, at);
};
const dir = (path: string, ageMs = 0): string => {
    mkdirSync(path, { recursive: true });
    age(path, ageMs);
    return path;
};

// A runner folder as config.sh and a few jobs leave it.
const runnerFolder = (root: string, n: number): string => {
    const runner = join(root, `actions-runner-${n}`);
    file(join(runner, ".runner"));
    writeFileSync(join(runner, ".runner"), `﻿${JSON.stringify({ agentName: `w${n}`, workFolder: "_work" })}`);
    writeFileSync(join(runner, ".service"), `actions.runner.intentic-intentic.w${n}.service\n`);
    return runner;
};

interface Fixture {
    readonly root: string;
    readonly runner: string;
    readonly cacheRoot: string;
}

const fixture = (): Fixture => {
    const root = tempDir("ci-janitor-");
    const runner = runnerFolder(root, 1);
    const work = join(runner, "_work");
    file(join(work, "_temp", "old-job.sh"), 100, 60 * 60_000);
    file(join(work, "_temp", "fresh-job.sh"), 100, 60_000);
    file(join(work, "_temp", "_github_home", ".docker", "config.json"));
    file(join(work, "_temp", "_github_home", ".npmrc"));
    file(join(runner, "_diag", "Runner_old.log"), 100, 20 * DAY);
    file(join(runner, "_diag", "pages", "old-page.log"), 100, 20 * DAY);
    file(join(runner, "_diag", "Worker_new.log"), 100, DAY);
    dir(join(runner, "bin.2.328.0"));
    dir(join(runner, "bin.2.329.0"));
    dir(join(runner, "externals.2.329.0"));
    return { root, runner, cacheRoot: tempDir("ci-janitor-cache-") };
};

const symlinkTo = async (link: string, target: string): Promise<void> => {
    const { symlink } = await import("node:fs/promises");
    await symlink(target, link);
};

const setUp = async (fx: Fixture, options: { runners?: FakeRunner[]; janitor?: Record<string, unknown>; extra?: Parameters<typeof runnerPrograms>[1] } = {}) => {
    await symlinkTo(join(fx.runner, "bin"), join(fx.runner, "bin.2.329.0"));
    await symlinkTo(join(fx.runner, "externals"), join(fx.runner, "externals.2.329.0"));
    const sys = fakeSys({ programs: runnerPrograms(options.runners ?? [], options.extra), now: NOW });
    const config = testConfig({ cacheRoot: fx.cacheRoot, janitor: JanitorConfigSchema.parse({ runnersGlob: join(fx.root, "actions-runner-*"), ...options.janitor }) });
    const { context } = await testContext(sys, config);
    return { sys, context };
};

const exists = (path: string): boolean => existsSync(path);

test("an idle runner's job leftovers, old logs, superseded version, stale update and oversized store go; what a job may still use stays", async () => {
    const fx = fixture();
    const work = join(fx.runner, "_work");
    file(join(work, "_update", "runner.tar.gz"), 100, 3 * DAY);
    age(join(work, "_update"), 3 * DAY);
    file(join(work, ".pnpm-store", "v3", "big"), 7 * GIB);
    const { context } = await setUp(fx);
    const pass = await runJanitorPass(context, { dryRun: false });
    expect(exists(join(work, "_temp", "old-job.sh"))).toBe(false);
    expect(exists(join(work, "_temp", "fresh-job.sh"))).toBe(true);
    expect(exists(join(work, "_temp", "_github_home", ".docker", "config.json"))).toBe(true);
    expect(exists(join(work, "_temp", "_github_home", ".npmrc"))).toBe(false);
    expect(exists(join(fx.runner, "_diag", "Runner_old.log"))).toBe(false);
    expect(exists(join(fx.runner, "_diag", "pages"))).toBe(false);
    expect(exists(join(fx.runner, "_diag", "Worker_new.log"))).toBe(true);
    expect(exists(join(fx.runner, "bin.2.328.0"))).toBe(false);
    expect(exists(join(fx.runner, "bin.2.329.0"))).toBe(true);
    expect(exists(join(fx.runner, "externals.2.329.0"))).toBe(true);
    expect(exists(join(work, "_update"))).toBe(false);
    expect(exists(join(work, ".pnpm-store"))).toBe(false);
    expect(pass.freedBytes).toBeGreaterThan(7 * GIB);
    expect(pass.lines).toContain(`removed 2 entries (0.0 GB) a finished job left in ${join(work, "_temp")}`);
    expect(pass.lines.some((line) => line.startsWith(`removed ${join(work, ".pnpm-store")} (7.0 GB): over the 6 GB cap`))).toBe(true);
    // Everything went through the trash, and the trash is empty again.
    expect(readdirSync(join(context.config.stateDir, "trash"))).toEqual([]);
    expect(context.status.read().janitor?.lines.at(-1)).toMatch(/^done: freed 7\.0 GB on \//u);
});

test("a busy runner is left whole and the shared caches wait for an idle fleet", async () => {
    const fx = fixture();
    file(join(fx.cacheRoot, "xwin", "big"), 16 * GIB);
    const runners: FakeRunner[] = [{ unit: "actions.runner.intentic-intentic.w1.service", dir: fx.runner, name: "w1", worker: 42 }];
    const { context } = await setUp(fx, { runners });
    const pass = await runJanitorPass(context, { dryRun: false });
    expect(exists(join(fx.runner, "_work", "_temp", "old-job.sh"))).toBe(true);
    expect(exists(join(fx.runner, "bin.2.328.0"))).toBe(true);
    expect(exists(join(fx.cacheRoot, "xwin"))).toBe(true);
    expect(pass.lines).toContain("shared caches: skipped, a job is running (the next idle pass takes them)");
    expect(pass.lines[0]).toMatch(/busy runners: actions-runner-1$/u);
});

test("shared caches: a stale target, one over its cap, then the least recently built until the joint cap; other entries by their own cap", async () => {
    const fx = fixture();
    const c = fx.cacheRoot;
    file(join(c, "stale-target", "debug", "x"), 10, 20 * DAY);
    age(join(c, "stale-target", "debug"), 20 * DAY);
    age(join(c, "stale-target"), 20 * DAY);
    file(join(c, "huge-target", "x"), 21 * GIB, DAY);
    file(join(c, "a-target", "x"), 15 * GIB, 3 * DAY);
    age(join(c, "a-target"), 3 * DAY);
    file(join(c, "b-target", "x"), 19 * GIB, 2 * DAY);
    age(join(c, "b-target"), 2 * DAY);
    file(join(c, "c-target", "x"), 19 * GIB, 0);
    file(join(c, "d-target", "x"), 19 * GIB, 0);
    file(join(c, "pnpm-store", "x"), 19 * GIB);
    file(join(c, "cargo", "x"), 21 * GIB);
    file(join(c, "ms-playwright", "x"), 16 * GIB);
    file(join(c, "onboarding-docker", "x"), 29 * GIB);
    const { context } = await setUp(fx);
    const pass = await runJanitorPass(context, { dryRun: false });
    const gone = ["stale-target", "huge-target", "a-target", "cargo", "ms-playwright"];
    const kept = ["b-target", "c-target", "d-target", "pnpm-store", "onboarding-docker"];
    expect(gone.filter((name) => exists(join(c, name)))).toEqual([]);
    expect(kept.filter((name) => !exists(join(c, name)))).toEqual([]);
    expect(pass.lines).toContain(`removed ${join(c, "stale-target")} (0.0 GB): no build wrote to it in 14 days`);
    expect(pass.lines.some((line) => line.startsWith(`removed ${join(c, "a-target")} (15.0 GB): the target dirs add up to 72.0 GB`))).toBe(true);
    expect(context.status.read().caches.map((cache) => cache.name)).toEqual(["b-target", "c-target", "d-target", "onboarding-docker", "pnpm-store"]);
});

test("turbo over its cap loses files older than 3 days, then older than 1 day only if that was not enough", async () => {
    const fx = fixture();
    const turbo = join(fx.cacheRoot, "turbo");
    file(join(turbo, "old"), 6 * GIB, 5 * DAY);
    file(join(turbo, "mid"), 9 * GIB, 2 * DAY);
    file(join(turbo, "new"), 2 * GIB, 0);
    const { context } = await setUp(fx);
    const pass = await runJanitorPass(context, { dryRun: false });
    expect(readdirSync(turbo)).toEqual(["new"]);
    expect(pass.lines).toContain("turbo: deleted entries older than 3d, 17.0 -> 11.0 GB");
    expect(pass.lines).toContain("turbo: deleted entries older than 1d, 11.0 -> 2.0 GB");
});

test("a dry run removes nothing and says what it would", async () => {
    const fx = fixture();
    file(join(fx.cacheRoot, "xwin", "big"), 16 * GIB);
    file(join(fx.cacheRoot, "turbo", "x"), 11 * GIB, 5 * DAY);
    const { context } = await setUp(fx);
    const pass = await runJanitorPass(context, { dryRun: true });
    expect(exists(join(fx.runner, "_work", "_temp", "old-job.sh"))).toBe(true);
    expect(exists(join(fx.runner, "_diag", "Runner_old.log"))).toBe(true);
    expect(exists(join(fx.cacheRoot, "xwin"))).toBe(true);
    expect(pass.dryRun).toBe(true);
    expect(pass.freedBytes).toBe(0);
    expect(pass.lines).toEqual(
        expect.arrayContaining([
            `would remove 2 entries (0.0 GB) a finished job left in ${join(fx.runner, "_work", "_temp")}`,
            `would remove 2 runner log files older than 14d in ${join(fx.runner, "_diag")}`,
            `would remove ${join(fx.runner, "bin.2.328.0")} (0.0 GB): a runner version the bin link no longer points at`,
            "would delete turbo entries older than 3d (11.0 GB)",
            `would remove ${join(fx.cacheRoot, "xwin")} (16.0 GB): over its 15 GB cap`,
        ]),
    );
    // A dry run is no pass of the janitor's own: the status keeps the last real one.
    expect(context.status.read().janitor).toBeUndefined();
});

test("a checkout with too many packs is repacked as its owner with the runner's unit stopped, and the unit started again", async () => {
    const fx = fixture();
    const pack = join(fx.runner, "_work", "intentic", "intentic", ".git", "objects", "pack");
    for (let n = 0; n < 4; n += 1) {
        file(join(pack, `pack-${n}.pack`));
    }
    const unit = "actions.runner.intentic-intentic.w1.service";
    const { sys, context } = await setUp(fx, {
        janitor: { gitPacksMax: 3 },
        extra: (command) => (command === "stat" ? exec("radarsu\n") : command === "runuser" ? exec("") : undefined),
    });
    const pass = await runJanitorPass(context, { dryRun: false });
    const asked = sys.calls.filter((call) => ["systemctl", "runuser"].includes(call[0] ?? "")).map((call) => call.slice(0, 3).join(" "));
    expect(asked).toEqual([`systemctl stop ${unit}`, "runuser -u radarsu", "runuser -u radarsu", `systemctl start ${unit}`]);
    expect(sys.calls.find((call) => call.includes("gc"))).toEqual(["runuser", "-u", "radarsu", "--", "git", "-c", "safe.directory=*", "-c", "gc.auto=0", "-C", join(fx.runner, "_work", "intentic", "intentic"), "gc", "--prune=now", "--quiet"]);
    expect(pass.lines.some((line) => line.startsWith(`repacked ${join(fx.runner, "_work", "intentic", "intentic")}: 4 packs`))).toBe(true);
});

test("a pass that frees past the compaction threshold leaves the request wsl-maintenance.ps1 reads", async () => {
    const fx = fixture();
    file(join(fx.cacheRoot, "xwin", "big"), 16 * GIB);
    const { context } = await setUp(fx, { janitor: { compactRequestGb: 10 } });
    await runJanitorPass(context, { dryRun: false });
    expect(readFileSync(join(context.config.stateDir, "compact-requested"), "utf8")).toMatch(/^2026-11-24T12:00:00\.000Z freed 16\.0 GB\n$/u);
});

test("the buildkit builder is started for its prune, capped and stopped again", async () => {
    const fx = fixture();
    let du = 0;
    const docker = (command: string, args: readonly string[]) => {
        if (command !== "docker") {
            return undefined;
        }
        const said = args.join(" ");
        if (said.startsWith("ps -aq")) {
            return exec("abc\n");
        }
        if (said.includes("buildctl du")) {
            du += 1;
            return exec(`ID\tRECLAIMABLE\nTotal:\t${du === 1 ? "30.5GB" : "20.5GB"}\n`);
        }
        return exec("");
    };
    const { sys, context } = await setUp(fx, { extra: docker });
    const pass = await runJanitorPass(context, { dryRun: false });
    const asked = sys.calls.filter((call) => call[0] === "docker").map((call) => call.slice(1).join(" "));
    expect(asked).toContain("start buildx_buildkit_intentic-cache0");
    expect(asked).toContain(`exec buildx_buildkit_intentic-cache0 buildctl prune --keep-storage ${25 * 1024}`);
    expect(asked.at(-1)).toBe("stop buildx_buildkit_intentic-cache0");
    expect(pass.lines).toContain("buildkit buildx_buildkit_intentic-cache0: 30.5GB -> 20.5GB (cap 25 GB)");
    expect(pass.lines.at(-1)).toMatch(/10\.0 GB|9\.3 GB of buildkit state/u);
    expect(humanToBytes("99.36GB")).toBe(99_360_000_000);
    expect(buildctlTotal("ID\nTotal:\t1.2MB\n")).toBe("1.2MB");
});

test("no docker is said once and leaves buildkit for the next pass", async () => {
    const { context } = await setUp(fixture());
    const pass = await runJanitorPass(context, { dryRun: false });
    expect(pass.lines).toContain("docker not answering in this distro; buildkit left for the next pass");
});
