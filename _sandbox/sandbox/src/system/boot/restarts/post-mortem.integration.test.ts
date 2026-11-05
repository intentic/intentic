import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kernelLinesOf } from "../../resources/kernel-oom-lines.js";
import { MEMORY_KILLS_FILE, NETD_KILLS_FILE, type PostMortem, PRESSURE_FILE } from "../../resources/memory-records.js";
import {
    at,
    BOOT_AT,
    CONTAINER_ID,
    CULPRIT,
    DAEMON_PID,
    guardKill,
    jsonLines,
    KERNEL_ZERO,
    kmsgText,
    netdKills,
    NIGHT_SUMMARY,
    pressure,
    STARTED_AT,
} from "./memory-incident.testing.js";
import { collectPostMortem, type PostMortemSources, readFiledPostMortems, readPostMortem, resetPostMortem } from "./post-mortem.js";
import { RESTARTS_FILE } from "./restart-record.js";

/* The post-mortem drawn from the files a stop leaves on the history volume, and handed to the resume pass once. */

let root: string;
let logs: string;

const sources = (kmsg: string = kmsgText(), containerId: string | undefined = CONTAINER_ID): PostMortemSources => ({
    kernelLog: () => ({ lines: kernelLinesOf(kmsg), source: "kmsg" }),
    containerId: () => containerId,
    kernelZero: () => KERNEL_ZERO,
});

const night = async (): Promise<void> => {
    await writeFile(join(logs, NETD_KILLS_FILE), jsonLines(netdKills()));
    // netd rotated its samples once in the night.
    const [early, late] = pressure();
    await writeFile(join(logs, `${PRESSURE_FILE}.1`), jsonLines([early]));
    await writeFile(join(logs, PRESSURE_FILE), jsonLines([late]));
};

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "post-mortem-"));
    logs = join(root, "logs");
    await mkdir(logs);
    resetPostMortem();
});

afterEach(async () => {
    resetPostMortem();
    await rm(root, { recursive: true, force: true });
});

const previous = { ended: "killed" as const, pid: DAEMON_PID, startedAt: STARTED_AT };

test("the night's files and the kernel's lines name the cause, the culprit and the hand, from the run that began it", async () => {
    await night();
    const found = collectPostMortem(logs, join(root, "boot-history.json"), previous, BOOT_AT, sources());
    expect(found?.namedEnding).toBe("netd-stuck");
    expect(found?.postMortem).toMatchObject({ cause: "memory", culprits: [CULPRIT], summary: NIGHT_SUMMARY });
});

test("a kill in another container on the machine is not this sandbox's, and is only counted", async () => {
    await night();
    const elsewhere = kmsgText(`/wsl-user/distro-4261/docker/${"b".repeat(64)}/workload`);
    const found = collectPostMortem(logs, join(root, "boot-history.json"), previous, BOOT_AT, sources(elsewhere));
    // What is left of the night is netd's part, and the machine running out around it.
    expect(found?.postMortem).toMatchObject({ cause: "netd-stuck", killed: [], culprits: [] });
    expect(found?.postMortem.summary).toMatch(/; the kernel's global OOM also killed a process outside this sandbox$/u);
});

test("a chain of starts netd killed before their hello reaches back to the stuck run on boot-history.json", async () => {
    await night();
    const stuckRun = at("02:18:38");
    const failedStarts = [at("04:15:30"), at("04:18:30")];
    // Two failed starts that recorded themselves, each killed for its silence a little under three minutes later.
    await writeFile(
        join(logs, NETD_KILLS_FILE),
        jsonLines([...netdKills().slice(0, 1), ...failedStarts.map((start) => ({ at: start + 179_000, kind: "no-hello", silentMs: 179_500 }))]),
    );
    await writeFile(join(root, "boot-history.json"), JSON.stringify({ boots: [stuckRun, ...failedStarts] }));
    const marker = { ended: "killed" as const, pid: 15_999, startedAt: failedStarts[1] ?? 0 };
    const found = collectPostMortem(logs, join(root, "boot-history.json"), marker, BOOT_AT, sources());
    expect(found?.postMortem.summary).toMatch(/^netd killed the daemon after its event loop stopped answering for 300 s while memory pressure was 47%, then 2 daemons it restarted/u);
    expect(found?.postMortem.culprits).toEqual([CULPRIT]);
});

test("a kill the run survived names nothing: measured from a crash's own end, or from the daemon's last minute sample", async () => {
    const survived = guardKill({ at: at("01:00:00"), owner: "wise-fern-usz1" });
    await writeFile(join(logs, MEMORY_KILLS_FILE), jsonLines([survived]));
    // Memory was short around the kill, and netd sampled it then.
    await writeFile(join(logs, PRESSURE_FILE), jsonLines([{ at: at("01:00:20"), psi: { someAvg10: 61, fullAvg10: 20 }, top: [] }]));
    const run = { pid: DAEMON_PID, startedAt: at("00:30:00") };
    const quiet = sources("");
    const crashed = collectPostMortem(logs, join(root, "boot-history.json"), { ended: "crashed", ...run, endedAt: at("04:00:00") }, at("04:00:03"), quiet);
    expect(crashed?.postMortem).toMatchObject({ cause: "unknown", culprits: [], killed: [survived] });
    // Killed with no end of its own on file, the run lived on by its minute samples until 03:59.
    const killed = collectPostMortem(logs, join(root, "boot-history.json"), { ended: "killed", ...run }, at("04:00:03"), quiet);
    expect(killed?.postMortem.cause).toBe("memory");
    await writeFile(join(logs, "resource-metrics.jsonl"), jsonLines([{ at: new Date(at("03:58:00")).toISOString() }, { at: new Date(at("03:59:00")).toISOString() }]));
    const sampled = collectPostMortem(logs, join(root, "boot-history.json"), { ended: "killed", ...run }, at("04:00:03"), quiet);
    expect(sampled?.postMortem).toMatchObject({ cause: "unknown", culprits: [] });
});

test("after a clean stop there is none; after a first boot with nothing found there is none either", () => {
    expect(collectPostMortem(logs, join(root, "boot-history.json"), { ended: "stopped" }, BOOT_AT, sources())).toBeUndefined();
    expect(collectPostMortem(logs, join(root, "boot-history.json"), { ended: "unknown" }, BOOT_AT, sources(""))).toBeUndefined();
});

test("the resume pass reads the post-mortem filed with the newest boot, once, and draws one where it was not filed", async () => {
    await night();
    await writeFile(join(logs, MEMORY_KILLS_FILE), jsonLines([guardKill({ at: at("04:00:00") })]));
    const filed: PostMortem = { cause: "memory", killed: [], netd: [], culprits: ["filed-one"], summary: "as filed" };
    await writeFile(
        join(logs, RESTARTS_FILE),
        jsonLines([
            { at: new Date(at("02:18:38")).toISOString(), boot: { pid: 65, version: "1" }, previous: { ended: "stopped", graceful: true } },
            { at: new Date(BOOT_AT).toISOString(), boot: { pid: 14573, version: "1" }, previous: { ended: "netd-stuck", graceful: false, pid: 65, postMortem: filed } },
        ]),
    );
    expect(await readPostMortem(root, sources())).toEqual(filed);
    // Once per boot: the file changing after does not change the answer.
    await writeFile(join(logs, RESTARTS_FILE), "");
    expect(await readPostMortem(root, sources())).toEqual(filed);

    // A record from a build that filed none: drawn from the records, for the run it names.
    resetPostMortem();
    await writeFile(
        join(logs, RESTARTS_FILE),
        jsonLines([{ at: new Date(BOOT_AT).toISOString(), boot: { pid: 14573 }, previous: { ended: "killed", graceful: false, pid: 65, startedAt: new Date(STARTED_AT).toISOString() } }]),
    );
    const drawn = await readPostMortem(root, sources());
    expect(drawn?.culprits).toEqual(["wise-fern-usz1", CULPRIT]);
    expect(drawn?.cause).toBe("memory");

    // No record at all: nothing to say.
    resetPostMortem();
    await rm(join(logs, RESTARTS_FILE));
    expect(await readPostMortem(root, sources())).toBeUndefined();
});

test("the diagnostics tool reads every filed post-mortem in its window, newest first", async () => {
    const one = { cause: "netd-stuck", killed: [], netd: [], culprits: [], summary: "netd killed the daemon after its event loop stopped answering for 300 s" };
    const two = { ...one, cause: "memory", culprits: [CULPRIT], summary: NIGHT_SUMMARY };
    await writeFile(
        join(logs, RESTARTS_FILE),
        jsonLines([
            { at: "2026-11-04T10:00:00.000Z", boot: {}, previous: { ended: "netd-stuck", postMortem: one } },
            { at: "2026-11-05T01:00:00.000Z", boot: {}, previous: { ended: "stopped" } },
            { at: new Date(BOOT_AT).toISOString(), boot: {}, previous: { ended: "netd-stuck", postMortem: two } },
            { at: "2026-11-05T05:00:00.000Z", boot: {}, previous: { ended: "some-ending-from-the-future", postMortem: one } },
        ]),
    );
    expect(readFiledPostMortems(logs, undefined).map(({ at: when, ended, postMortem }) => [new Date(when).toISOString(), ended, postMortem.cause])).toEqual([
        ["2026-11-05T05:00:00.000Z", undefined, "netd-stuck"],
        [new Date(BOOT_AT).toISOString(), "netd-stuck", "memory"],
        ["2026-11-04T10:00:00.000Z", "netd-stuck", "netd-stuck"],
    ]);
    expect(readFiledPostMortems(logs, at("00:00:00"))).toHaveLength(2);
});
