import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    busyBetween,
    calmVerdict,
    CARGO_JOB_BYTES,
    cargoChosen,
    cargoJobs,
    cargoParallelism,
    idlestCpus,
    parseArgs,
    parseProcStat,
    STUCK_MS,
    waitForIdle,
} from "./heavy-launch.cjs";

// (2026-11-19, the shinobi-society audit) Agents set -j, CARGO_BUILD_JOBS, --test-threads or nice by hand on 729
// commands in 46 conversations, and checked `free -m` 158 times to pick a number. The launcher picks it from the room the
// queue gave the command, and an agent's own choice always stands.

const GIB = 1024 ** 3;
// A look at the CPUs: `busy` of `count` cores busy.
const look = (busy: number, count = 16, own?: number) => ({ busy, count, own, perCpu: Array.from({ length: count }, (_, cpu) => ({ cpu, busy: busy / count })) });

let home: string;
beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "heavy-launch-"));
});
afterEach(async () => {
    await rm(home, { recursive: true, force: true });
});

describe("cargo's jobs", () => {
    test("its share of the cores the heavy slots split, bounded by the memory it was given at a job's worth each", () => {
        expect(cargoJobs({ cores: 16, slots: 2, idle: 16, roomBytes: 14 * GIB })).toBe(8);
        expect(cargoJobs({ cores: 16, slots: 2, idle: 16, roomBytes: 3.5 * GIB })).toBe(3);
        expect(cargoJobs({ cores: 16, slots: 1, idle: 16, roomBytes: undefined })).toBe(16);
    });

    test("other work keeping cores busy takes it down to half its share, never below; and never under one job", () => {
        expect(cargoJobs({ cores: 16, slots: 2, idle: 6, roomBytes: 20 * GIB })).toBe(6);
        expect(cargoJobs({ cores: 16, slots: 2, idle: 0, roomBytes: 20 * GIB })).toBe(4);
        expect(cargoJobs({ cores: 16, slots: 2, idle: 16, roomBytes: 0.2 * GIB })).toBe(1);
        expect(CARGO_JOB_BYTES).toBe(GIB);
    });

    test("the command's own -j, --jobs or --test-threads, its environment and the project's cargo config always win", async () => {
        const cwd = join(home, "game");
        await mkdir(join(cwd, ".cargo"), { recursive: true });
        const env = { HOME: home };
        expect(cargoChosen({ args: ["build", "-j", "2"], env, cwd })).toEqual({ jobs: true, threads: false });
        expect(cargoChosen({ args: ["build", "-j2"], env, cwd }).jobs).toBe(true);
        expect(cargoChosen({ args: ["test", "--jobs=3", "--", "--test-threads=1"], env, cwd })).toEqual({ jobs: true, threads: true });
        expect(cargoChosen({ args: ["test"], env: { ...env, CARGO_BUILD_JOBS: "4", RUST_TEST_THREADS: "2" }, cwd })).toEqual({ jobs: true, threads: true });
        // `--test-threads` before `--` is cargo's own business, not libtest's.
        expect(cargoChosen({ args: ["test", "--test-threads", "1"], env, cwd })).toEqual({ jobs: false, threads: false });
        expect(cargoChosen({ args: ["build"], env, cwd }).jobs).toBe(false);
        await writeFile(join(cwd, ".cargo", "config.toml"), "[build]\njobs = 4\n");
        expect(cargoChosen({ args: ["build"], env, cwd: join(cwd, "crates", "engine") }).jobs).toBe(true);
    });

    test("what is left to choose is set, said in one line, and the test threads only for a test run", () => {
        const env = { HOME: home };
        const chosen = cargoParallelism({ args: ["test", "-p", "engine"], env, cwd: home, cores: 16, slots: 2, look: look(4), roomBytes: 6 * GIB });
        expect(chosen?.set).toEqual({ CARGO_BUILD_JOBS: "6", RUST_TEST_THREADS: "6" });
        expect(chosen?.line).toMatch(/^cargo: -j 6 and 6 test threads \(16 cores shared by 2 heavy slots, 4\.0 of 16 cores busy, 6\.0 GiB .*\)\. Pass -j/u);
        expect(cargoParallelism({ args: ["+nightly", "clippy"], env, cwd: home, cores: 16, slots: 2, look: look(0), roomBytes: undefined })?.set).toEqual({ CARGO_BUILD_JOBS: "8" });
        expect(cargoParallelism({ args: ["test", "--", "--test-threads=1"], env, cwd: home, cores: 16, slots: 2, look: look(0), roomBytes: undefined })?.set).toEqual({ CARGO_BUILD_JOBS: "8" });
        expect(cargoParallelism({ args: ["build", "-j", "3"], env, cwd: home, cores: 16, slots: 2, look: look(0), roomBytes: undefined })).toBeUndefined();
    });
});

describe("the CPUs", () => {
    const stat = (perCpu: [busy: number, idle: number][]): string =>
        ["cpu  0 0 0 0 0 0 0 0", ...perCpu.map(([busy, idle], cpu) => `cpu${cpu} ${busy} 0 0 ${idle} 0 0 0 0 0 0`), "intr 1 2 3"].join("\n");

    test("two looks at /proc/stat say how many cores were busy between them, in all and each", () => {
        const before = parseProcStat(stat([[100, 100], [100, 100], [100, 100]]));
        const after = parseProcStat(stat([[200, 100], [150, 150], [100, 200]]));
        const between = busyBetween(before, after);
        expect(between.count).toBe(3);
        expect(between.busy).toBeCloseTo(1.5);
        expect(between.perCpu.map((entry) => entry.busy)).toEqual([1, 0.5, 0]);
        // The idlest first, as a pin takes them, listed in order.
        expect(idlestCpus(between, 2, new Set([0, 1, 2]))).toEqual([1, 2]);
        expect(idlestCpus(between, 2, new Set([0, 1]))).toEqual([0, 1]);
    });

    // A fake clock and looks taken in turn: each pause moves the clock, so a wait's length is the looks it took.
    const timed = (looks: ReturnType<typeof look>[], last: ReturnType<typeof look>) => {
        let clock = 0;
        return { look: async () => looks.shift() ?? last, now: () => clock, pause: async (ms: number) => void (clock += ms) };
    };
    const quietly = async <T,>(body: (said: string[]) => Promise<T>): Promise<T> => {
        const said: string[] = [];
        const write = jest.spyOn(process.stderr, "write").mockImplementation((line) => said.push(String(line)) > 0);
        try {
            return await body(said);
        } finally {
            write.mockRestore();
        }
    };

    test("a wait for idle cores ends the moment they are idle, saying so while it waits", async () => {
        await quietly(async (said) => {
            const calm = await waitForIdle({ need: 8, ceilingSeconds: 60, prefix: "quiet", why: "", ...timed([look(15), look(14), look(4)], look(4)) });
            expect(calm).toMatchObject({ calm: true, waitedMs: 2000 });
            expect(said[0]).toMatch(/^\[quiet\] waiting for 8 idle cores: 15\.0 of 16 cores busy \(load .*\)\. It starts once they are idle, or once that load has gone 30s without easing\.\n$/u);
        });
    });

    // (2026-11-24, the shinobi-society audit) A quiet run counted down to its 10-minute ceiling whatever the load did, then
    // ran NOT calm anyway: waiting is worth it only while busy cores are coming free.
    test("a load that does not ease is not waited out: the wait ends once it has gone STUCK_MS without easing", async () => {
        await quietly(async () => {
            const steady = await waitForIdle({ need: 8, ceilingSeconds: 600, prefix: "quiet", why: "", ...timed([], look(15)) });
            expect(steady).toMatchObject({ calm: false, stopped: "stuck", waitedMs: STUCK_MS });
            // Easing by a core restarts the window, so a load that keeps coming down is waited for until the cores are idle.
            const easing = Array.from({ length: 8 }, (_, step) => look(15 - step));
            const eased = await waitForIdle({ need: 8, ceilingSeconds: 600, prefix: "quiet", why: "", stuckMs: 1500, ...timed(easing, look(8)) });
            expect(eased).toMatchObject({ calm: true });
            // The ceiling is a backstop only, for a load that keeps easing and never gets there.
            const capped = await waitForIdle({ need: 8, ceilingSeconds: 5, prefix: "capture", why: "", ...timed(Array.from({ length: 20 }, (_, step) => look(15 - step / 20)), look(15)) });
            expect(capped).toMatchObject({ calm: false });
        });
    });

    test("a quiet wait counts only the load outside this sandbox, which waiting can see ease; its own the gate waits out", async () => {
        await quietly(async (said) => {
            // 15 cores busy, 12 of them this sandbox's own builds: the 3 outside leave 13 idle once the gate drains them.
            const own = await waitForIdle({ need: 12, ceilingSeconds: 600, prefix: "quiet", why: "", outside: true, ...timed([], look(15, 16, 12)) });
            expect(own).toMatchObject({ calm: true, waitedMs: 0 });
            const outside = await waitForIdle({ need: 12, ceilingSeconds: 600, prefix: "quiet", why: "Nothing in this sandbox waits on this. ", outside: true, ...timed([], look(10, 16, 1)) });
            expect(outside).toMatchObject({ calm: false, stopped: "stuck" });
            expect(said[0]).toMatch(/^\[quiet\] waiting for 12 idle cores: 9\.0 of 16 cores busy outside this sandbox \(1\.0 in it\) \(load .*\)\. Nothing in this sandbox waits on this\. /u);
            // Where the sandbox's own share is unknown, every busy core counts.
            expect(await waitForIdle({ need: 12, ceilingSeconds: 600, prefix: "quiet", why: "", outside: true, ...timed([], look(15)) })).toMatchObject({ calm: false });
        });
    });

    test("a wait's verdict is one line: calm, how long it took, or why it went on not calm", () => {
        expect(calmVerdict({ calm: true, look: look(2), waitedMs: 300 }, true)).toBe("calm");
        expect(calmVerdict({ calm: true, look: look(2), waitedMs: 42_000 }, true)).toBe("calm after 42s");
        expect(calmVerdict({ calm: false, look: look(10, 16, 1), waitedMs: 31_000, stopped: "stuck" }, true)).toBe(
            "NOT calm (9.0 of 16 cores busy outside this sandbox (1.0 in it), not easing after 31s of waiting)",
        );
        // Rounded once: never 9m60s.
        expect(calmVerdict({ calm: false, look: look(15), waitedMs: 599_600, stopped: "ceiling" }, false)).toBe("NOT calm (15.0 of 16 cores busy, still busy at its 10m00s ceiling)");
    });
});

test("its flags come before `--`, and the command after it is untouched", () => {
    expect(parseArgs(["--calm-first", "--idle", "6", "--label", "quiet"])).toMatchObject({ calmFirst: true, idle: 6, command: ["--calm-first", "--idle", "6", "--label", "quiet"] });
    expect(parseArgs(["--calm-first", "--idle", "6", "--"])).toMatchObject({ calmFirst: true, idle: 6, command: [] });
    expect(parseArgs(["--parallel", "cargo", "--slots", "2", "--cpus", "4", "--pin", "--quiet", "--label", "x", "--", "cargo", "--pin", "-j"])).toMatchObject({
        command: ["cargo", "--pin", "-j"],
        parallel: "cargo",
        slots: 2,
        cpus: 4,
        pin: true,
        quiet: true,
        label: "x",
    });
});
