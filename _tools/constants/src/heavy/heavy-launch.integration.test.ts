import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    busyBetween,
    CARGO_JOB_BYTES,
    cargoChosen,
    cargoJobs,
    cargoParallelism,
    idlestCpus,
    parseArgs,
    parseProcStat,
    waitForIdle,
} from "./heavy-launch.cjs";

// (2026-11-19, the shinobi-society audit) Agents set -j, CARGO_BUILD_JOBS, --test-threads or nice by hand on 729
// commands in 46 conversations, and checked `free -m` 158 times to pick a number. The launcher picks it from the room the
// queue gave the command, and an agent's own choice always stands.

const GIB = 1024 ** 3;
// A look at the CPUs: `busy` of `count` cores busy.
const look = (busy: number, count = 16) => ({ busy, count, perCpu: Array.from({ length: count }, (_, cpu) => ({ cpu, busy: busy / count })) });

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

    test("a wait for idle cores ends once they are idle, or at its ceiling, saying so while it waits", async () => {
        const said: string[] = [];
        const write = jest.spyOn(process.stderr, "write").mockImplementation((line) => said.push(String(line)) > 0);
        try {
            let clock = 0;
            const looks = [look(15), look(14), look(4)];
            const calm = await waitForIdle({ need: 8, ceilingSeconds: 60, prefix: "quiet", why: "", look: async () => looks.shift() ?? look(4), now: () => clock, pause: async (ms: number) => void (clock += ms) });
            expect(calm).toMatchObject({ calm: true, waitedMs: 2000 });
            expect(said[0]).toMatch(/^\[quiet\] waiting for 8 idle cores: 15\.0 of 16 cores busy \(load .*\)\. It starts anyway in 1m00s\.\n$/u);
            const busy = await waitForIdle({ need: 8, ceilingSeconds: 5, prefix: "capture", why: "", look: async () => look(15), now: () => clock, pause: async (ms: number) => void (clock += ms) });
            expect(busy).toMatchObject({ calm: false });
        } finally {
            write.mockRestore();
        }
    });
});

test("its flags come before `--`, and the command after it is untouched", () => {
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
