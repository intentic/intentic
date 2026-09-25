import { OOM_SCORE, priorityOf, raisedScore, shellPrefix, type Workload, type WorkloadClass } from "./workload-class.js";

// The order is the contract: what the kernel takes first when the sandbox runs out, read off the class each spawner names.

const EVERY_CLASS: readonly Workload[] = [
    { class: "agentRuntime", spawnDepth: 0 },
    { class: "service" },
    { class: "panel" },
    { class: "install" },
    { class: "command" },
    { class: "toolchain" },
];

test("a turn's runtime, its children and its grandchildren each rank one level more killable", () => {
    expect(priorityOf({ class: "agentRuntime", spawnDepth: 0 }).oomScoreAdj).toBe(100);
    expect(priorityOf({ class: "agentRuntime", spawnDepth: 1 }).oomScoreAdj).toBe(200);
    expect(priorityOf({ class: "agentRuntime", spawnDepth: 2 }).oomScoreAdj).toBe(300);
});

test("however deep a spawn goes, its runtime stays below a restartable service", () => {
    expect(priorityOf({ class: "agentRuntime", spawnDepth: 3 }).oomScoreAdj).toBe(400);
    expect(priorityOf({ class: "agentRuntime", spawnDepth: 10 }).oomScoreAdj).toBe(400);
    expect(priorityOf({ class: "agentRuntime", spawnDepth: -1 }).oomScoreAdj).toBe(100);
});

test("the heavy tier belongs to the toolchain class alone", () => {
    const heavy: WorkloadClass[] = EVERY_CLASS.filter((workload) => priorityOf(workload).oomScoreAdj === OOM_SCORE.heavy).map(
        (workload) => workload.class,
    );
    expect(heavy).toEqual(["toolchain"]);
    expect(OOM_SCORE.heavy).toBe(800);
});

test("builds go first, then agent commands and installs, then services and panels, then any agent", () => {
    expect(Object.fromEntries(EVERY_CLASS.map((workload) => [workload.class, priorityOf(workload).oomScoreAdj]))).toEqual({
        toolchain: 800,
        command: 600,
        install: 600,
        service: 500,
        panel: 500,
        agentRuntime: 100,
    });
});

test("agent commands and builds run at the lowest CPU and IO priority, the rest at the workload's", () => {
    expect(Object.fromEntries(EVERY_CLASS.map((workload) => [workload.class, priorityOf(workload)]))).toEqual({
        agentRuntime: { nice: 10, lowIo: false, oomScoreAdj: 100 },
        service: { nice: 10, lowIo: false, oomScoreAdj: 500 },
        panel: { nice: 10, lowIo: false, oomScoreAdj: 500 },
        install: { nice: 10, lowIo: true, oomScoreAdj: 600 },
        command: { nice: 19, lowIo: true, oomScoreAdj: 600 },
        toolchain: { nice: 19, lowIo: true, oomScoreAdj: 800 },
    });
});

test("a score is only ever raised, so a process that ranked itself higher keeps its own", () => {
    expect(raisedScore(0, 300)).toBe(300);
    expect(raisedScore(300, 300)).toBeUndefined();
    expect(raisedScore(700, 300)).toBeUndefined();
});

test("the shell prefix renders the same class, and ends choom's own options", () => {
    expect(shellPrefix({ class: "command" })).toBe("nice -n 19 ionice -c 2 -n 7 choom -n 600 -- ");
    expect(shellPrefix({ class: "toolchain" })).toBe("nice -n 19 ionice -c 2 -n 7 choom -n 800 -- ");
    expect(shellPrefix({ class: "service" })).toBe("nice -n 10 choom -n 500 -- ");
});
