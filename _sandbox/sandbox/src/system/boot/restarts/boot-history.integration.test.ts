import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NETD_KILLS_FILE, type NetdKill } from "../../resources/memory-records.js";
import { bootFacts, bootFactsOf, keptBoots, recordBoot, resetBootRecord, RESTART_STORM, restartStormProblem } from "./boot-history.js";

/* A restart storm is told from a restart by the boots before this one, and decides only whether this boot resumes. */

const MINUTE = 60_000;
const NOW = 1_780_000_000_000;
const quiet = { warn: () => undefined };

afterEach(() => resetBootRecord());

test("the third boot within half an hour is a storm, this boot counted", () => {
    expect(RESTART_STORM).toEqual({ boots: 3, windowMs: 30 * MINUTE });
    expect(bootFactsOf([], NOW)).toEqual({ bootedAt: NOW, bootsInWindow: 1, storm: false });
    expect(bootFactsOf([NOW - 10 * MINUTE], NOW)).toMatchObject({ bootsInWindow: 2, storm: false, previousBootAt: NOW - 10 * MINUTE });
    expect(bootFactsOf([NOW - 25 * MINUTE, NOW - 10 * MINUTE], NOW)).toMatchObject({ bootsInWindow: 3, storm: true });
});

test("boots outside the window, or in the future of a clock that stepped back, do not make a storm", () => {
    expect(bootFactsOf([NOW - 31 * MINUTE, NOW - 40 * MINUTE], NOW)).toMatchObject({ bootsInWindow: 1, storm: false });
    expect(bootFactsOf([NOW + MINUTE, NOW + 2 * MINUTE], NOW)).toMatchObject({ bootsInWindow: 1, storm: false });
});

// 2026-11-05: while a runaway thrashed the VM, netd killed every daemon it started that could not say hello in three
// minutes. Those that recorded their boot must not hold the one that finally came up from resuming the turns they cut.
test("boots netd killed before their hello are not counted towards a storm; boots that failed on their own still are", () => {
    const failed = new Set([NOW - 9 * MINUTE, NOW - 6 * MINUTE]);
    expect(bootFactsOf([NOW - 120 * MINUTE, ...failed], NOW, RESTART_STORM, failed)).toEqual({
        bootedAt: NOW,
        previousBootAt: NOW - 6 * MINUTE,
        bootsInWindow: 1,
        neverStartedInWindow: 2,
        storm: false,
    });
    expect(bootFactsOf([NOW - 12 * MINUTE, ...failed], NOW, RESTART_STORM, new Set([NOW - 9 * MINUTE]))).toMatchObject({ bootsInWindow: 3, storm: true });
});

test("which boots never started is read off netd's record of the daemons it killed", async () => {
    const root = await mkdtemp(join(tmpdir(), "boot-history-"));
    try {
        const starts = [NOW - 120 * MINUTE, NOW - 9 * MINUTE, NOW - 6 * MINUTE];
        const kills: NetdKill[] = [
            { at: NOW - 101 * MINUTE, kind: "stuck", pid: 65, silentMs: 5 * MINUTE },
            { at: NOW - 6 * MINUTE - 5_000, kind: "no-hello", pid: 100, silentMs: 3 * MINUTE - 5_000 },
            { at: NOW - 3 * MINUTE, kind: "no-hello", pid: 101, silentMs: 3 * MINUTE },
        ];
        await writeFile(join(root, "boot-history.json"), JSON.stringify({ boots: starts }));
        await mkdir(join(root, "logs"));
        await writeFile(join(root, "logs", NETD_KILLS_FILE), kills.map((kill) => `${JSON.stringify(kill)}\n`).join(""));
        expect(await recordBoot(root, quiet, { now: NOW })).toMatchObject({ bootsInWindow: 1, neverStartedInWindow: 2, storm: false });
        // Without netd's record, the same boots are a storm, as before.
        resetBootRecord();
        await rm(join(root, "logs", NETD_KILLS_FILE));
        expect(await recordBoot(root, quiet, { now: NOW + 1000 })).toMatchObject({ bootsInWindow: 4, storm: true });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("the record keeps a day of boots, oldest first, and this one", () => {
    expect(keptBoots([NOW - 25 * 60 * MINUTE, NOW - 5 * MINUTE, NOW - 60 * MINUTE], NOW)).toEqual([NOW - 60 * MINUTE, NOW - 5 * MINUTE, NOW]);
    expect(
        keptBoots(
            Array.from({ length: 80 }, (_, index) => NOW - index * 1000),
            NOW,
        ),
    ).toHaveLength(50);
});

test("a boot is recorded once per process, on the history volume, with the restart ask it follows", async () => {
    const root = await mkdtemp(join(tmpdir(), "boot-history-"));
    try {
        const first = await recordBoot(root, quiet, { now: NOW, restartAskedAt: async () => NOW - MINUTE });
        expect(first).toEqual({ bootedAt: NOW, bootsInWindow: 1, storm: false, restartAskedAt: NOW - MINUTE });
        // The same process asking again gets the same answer, and writes nothing more.
        expect(await recordBoot(root, quiet, { now: NOW + MINUTE })).toBe(first);
        expect(await bootFacts()).toBe(first);
        // Two more boots, as two more processes would make them.
        resetBootRecord();
        await recordBoot(root, quiet, { now: NOW + 5 * MINUTE });
        resetBootRecord();
        expect(await recordBoot(root, quiet, { now: NOW + 9 * MINUTE })).toMatchObject({
            bootsInWindow: 3,
            storm: true,
            previousBootAt: NOW + 5 * MINUTE,
        });
        expect(JSON.parse(await readFile(join(root, "boot-history.json"), "utf8"))).toEqual({ boots: [NOW, NOW + 5 * MINUTE, NOW + 9 * MINUTE] });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a daemon with no history volume keeps no record and never reads as a storm", async () => {
    expect(await recordBoot("", quiet, { now: NOW })).toBeUndefined();
});

test("the owner's card says what happened and what to do, in the reporting shape the card already draws", () => {
    const problem = restartStormProblem({ bootedAt: NOW, bootsInWindow: 4, storm: true });
    expect(problem.kind).toBe("invalidEntry");
    expect(problem.detail).toContain("4 times within 30 minutes");
    expect(problem.fix).toContain("send a message");
});
