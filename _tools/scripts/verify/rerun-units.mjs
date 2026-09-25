#!/usr/bin/env node
// Re-runs only named failing units in the tree it is started in (its cwd), never the suite: how the sandbox asks one
// land's own tree whether it reproduces a main-line failure (the daemon's land bisect, agents/land/land-bisect.ts,
// which verify.mjs's report points at through `rerun`). Reads the units that report named from the file
// INTENTIC_RERUN_UNITS names. Only test units re-run on their own, and a test file this tree does not have cannot fail
// in it.
// Exit 1: at least one reproduced (printed); 0: none did; 2: nothing in the list re-runs alone (typecheck, lint, a whole
// task), so this tree cannot say.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readWorkspaceGraph } from "../../checks/lib/workspace-graph.mjs";
import { taskOf } from "./failure-units.mjs";
import { rerunFailures, testUnitParts } from "./flakes.mjs";

const REPRODUCED = 1;
const CANNOT_SAY = 2;

const root = process.cwd();
const listing = process.env.INTENTIC_RERUN_UNITS;
if (listing === undefined || listing === "") {
    console.error("rerun-units: INTENTIC_RERUN_UNITS names no file");
    process.exit(CANNOT_SAY);
}
const units = JSON.parse(readFileSync(listing, "utf8")).filter((unit) => typeof unit === "string");
const graph = readWorkspaceGraph(root);

// A unit's turbo task as flakes.mjs reads it (`<package>#<task>` and the package's directory), or undefined for a task
// no package in this tree owns.
const taskFor = (taskId) => {
    const at = taskId.lastIndexOf("#");
    const pkg = at === -1 ? undefined : graph.packages.get(taskId.slice(0, at));
    return pkg === undefined ? undefined : { taskId, task: taskId.slice(at + 1), directory: pkg.dir };
};
const tasks = [...new Set(units.map(taskOf))].map(taskFor).filter((task) => task !== undefined);
const byTask = new Map(tasks.map((task) => [task.taskId, task]));
const partsOf = (unit) => testUnitParts(unit, byTask.get(taskOf(unit)));

const runnable = units.filter((unit) => partsOf(unit) !== undefined);
if (runnable.length === 0) {
    console.error("rerun-units: nothing in the list re-runs on its own");
    process.exit(CANNOT_SAY);
}
const present = runnable.filter((unit) => existsSync(join(root, byTask.get(taskOf(unit)).directory, partsOf(unit).file)));
if (present.length === 0) {
    console.error(`rerun-units: none of the ${runnable.length} failing test file(s) exist in this tree`);
    process.exit(0);
}
const { still } = rerunFailures(root, tasks, present);
if (still.length > 0) {
    console.error(`rerun-units: ${still.length} of ${present.length} reproduced:\n${still.map((unit) => `  ${unit}`).join("\n")}`);
    process.exit(REPRODUCED);
}
console.error(`rerun-units: none of ${present.length} reproduced`);
