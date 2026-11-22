import { appendSpawnCostNote } from "./run-cost-note.js";

test("a workflow logs the first significant child estimate once", () => {
    const log = ["phase: inspect"];
    appendSpawnCostNote(log, "Running here. Each subagent here checks out about 3.7 GB; rest wait.");
    appendSpawnCostNote(log, "Each subagent here checks out about 4.0 GB; rest wait.");
    expect(log).toEqual(["phase: inspect", "Each subagent here checks out about 3.7 GB; rest wait."]);
});

test("insignificant estimates do not change the workflow log", () => {
    const log: string[] = [];
    appendSpawnCostNote(log, "Running here.");
    expect(log).toEqual([]);
});
