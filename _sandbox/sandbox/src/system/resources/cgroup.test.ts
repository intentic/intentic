import { flatKeyed, parsePressure, readCgroup, readPressure } from "./cgroup.js";

// A kernel whose files say exactly what the test gives them, and nothing else exists.
const files =
    (texts: Record<string, string>) =>
    async (path: string): Promise<string | undefined> =>
        texts[path];

// Real PSI shapes: memory/io carry both lines, cpu only `some`, and a kernel without PSI serves nothing parseable.
describe("pressure", () => {
    test("parses some+full avg10 from a pressure file", () => {
        const text = ["some avg10=1.50 avg60=0.12 avg300=0.08 total=659900661", "full avg10=0.75 avg60=0.12 avg300=0.08 total=572106466"].join("\n");
        expect(parsePressure(text)).toEqual({ some: 1.5, full: 0.75 });
    });

    test("cpu pressure has no full line: reported as 0, not absent", () => {
        expect(parsePressure("some avg10=2.25 avg60=0.00 avg300=0.10 total=3286364632\n")).toEqual({ some: 2.25, full: 0 });
    });

    test("unparseable content is undefined, never a throw", () => {
        expect(parsePressure("")).toBeUndefined();
        expect(parsePressure("not a pressure file")).toBeUndefined();
    });

    test("the cgroup's own stall figures win, and the host's stand in only where the cgroup keeps none", async () => {
        const pressure = await readPressure(
            files({
                "/sys/fs/cgroup/memory.pressure": "some avg10=12.25 avg60=0.00 avg300=0.00 total=1\nfull avg10=3.00 avg60=0.00 avg300=0.00 total=0\n",
                "/proc/pressure/memory": "some avg10=90.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=80.00 avg60=0.00 avg300=0.00 total=0\n",
                "/proc/pressure/io": "some avg10=4.00 avg60=0.00 avg300=0.00 total=1\nfull avg10=2.00 avg60=0.00 avg300=0.00 total=0\n",
            }),
        );
        expect(pressure).toEqual({ cpu: undefined, memory: { some: 12.25, full: 3 }, io: { some: 4, full: 2 } });
    });
});

describe("the cgroup reading", () => {
    test("a flat-keyed file is read by whole key, not by prefix", () => {
        const stat = flatKeyed("usage_usec 14857435323\nuser_usec 11580537798\nsystem_usec 3276897525\n");
        expect(stat["usage_usec"]).toBe(14_857_435_323);
        expect(flatKeyed("active_file 5\ninactive_file 7\n")["inactive_file"]).toBe(7);
        expect(flatKeyed("active_file 5\n")["file"]).toBeUndefined();
        expect(flatKeyed("MemTotal:  32617112\n")).toEqual({ MemTotal: 32_617_112 });
    });

    test("memory used is the working set: current use less the inactive file cache the kernel reclaims first", async () => {
        const reading = await readCgroup(
            files({
                "/sys/fs/cgroup/memory.current": `${10 * 2 ** 30}\n`,
                "/sys/fs/cgroup/memory.max": `${16 * 2 ** 30}\n`,
                "/sys/fs/cgroup/memory.stat": `anon 1\nfile 2\ninactive_file ${3 * 2 ** 30}\n`,
                "/sys/fs/cgroup/memory.swap.current": `${2 ** 30}\n`,
                "/sys/fs/cgroup/memory.swap.max": "max\n",
                "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 12\noom 1\noom_kill 1\noom_group_kill 0\n",
            }),
        );
        expect(reading).toMatchObject({
            memoryBytes: 10 * 2 ** 30,
            workingSetBytes: 7 * 2 ** 30,
            memoryLimitBytes: 16 * 2 ** 30,
            swapBytes: 2 ** 30,
            swapLimitBytes: undefined,
            memoryEvents: { low: 0, high: 0, max: 12, oom: 1, oom_kill: 1, oom_group_kill: 0 },
        });
    });

    test("a CPU quota is cores, `max` is none, and cpu.stat gives the usage and what the quota took back", async () => {
        const stat = [
            "usage_usec 123456789",
            "user_usec 100",
            "system_usec 200",
            "nr_periods 4000",
            "nr_throttled 1200",
            "throttled_usec 95000000",
            "",
        ];
        const quota = await readCgroup(files({ "/sys/fs/cgroup/cpu.max": "150000 100000\n", "/sys/fs/cgroup/cpu.stat": stat.join("\n") }));
        expect(quota).toMatchObject({
            cpuQuotaCores: 1.5,
            cpuUsageMicros: 123_456_789,
            cpuThrottle: { throttledMs: 95_000, throttledPeriods: 1200 },
        });
        const unlimited = await readCgroup(files({ "/sys/fs/cgroup/cpu.max": "max 100000\n", "/sys/fs/cgroup/cpu.stat": "usage_usec 1\n" }));
        // A cpu.stat without the throttle counters answers nothing about throttling, never zero.
        expect(unlimited).toMatchObject({ cpuQuotaCores: undefined, cpuUsageMicros: 1, cpuThrottle: undefined });
    });

    test("without a cgroup every figure is unknown rather than zero", async () => {
        expect(await readCgroup(files({}))).toEqual({
            cpuUsageMicros: undefined,
            cpuThrottle: undefined,
            cpuQuotaCores: undefined,
            memoryBytes: undefined,
            workingSetBytes: undefined,
            memoryLimitBytes: undefined,
            swapBytes: undefined,
            swapLimitBytes: undefined,
            memoryEvents: {},
            pressure: { cpu: undefined, memory: undefined, io: undefined },
        });
    });
});
