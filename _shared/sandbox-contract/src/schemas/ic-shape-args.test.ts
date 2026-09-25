import { icForgetShapeArgs, icPowerArgs, icShapeArgs, SandboxShapeSchema } from "./devices.js";

// The one TS spelling of ic's shape and power verbs: the machine agent runs these and the Devices view prints them for a
// person to type, so a drift here is a command that fails on the machine, or one that does something else there.

test("a whole shape is every flag, with the contract's null as ic's `default`", () => {
    expect(icShapeArgs("work", { memoryGib: 20, cpus: null, privileged: false, gpu: true }, "nextRestart")).toEqual([
        "sandbox",
        "shape",
        "work",
        "--memory",
        "20g",
        "--cpus",
        "default",
        "--privileged",
        "off",
        "--gpus",
        "on",
        "--when",
        "next-restart",
    ]);
    expect(icShapeArgs("work", { memoryGib: null, cpus: 4, privileged: true, gpu: false }, "now").slice(3)).toEqual([
        "--memory",
        "default",
        "--cpus",
        "4",
        "--privileged",
        "on",
        "--gpus",
        "off",
        "--when",
        "now",
    ]);
});

test("a field left out is left to ic, which keeps what it has for it", () => {
    expect(icShapeArgs("work", { memoryGib: 12 }, "now")).toEqual(["sandbox", "shape", "work", "--memory", "12g", "--when", "now"]);
});

test("forgetting and power name only the sandbox", () => {
    expect(icForgetShapeArgs("work")).toEqual(["sandbox", "shape", "work", "--forget"]);
    expect(icPowerArgs("restart", "work")).toEqual(["sandbox", "restart", "work"]);
});

// A shape is whole: a delta would put the merge back into every reader, which is what this schema exists to end.
test("a shape missing a field is not a shape", () => {
    expect(SandboxShapeSchema.safeParse({ memoryGib: 20, cpus: null, privileged: false }).success).toBe(false);
    expect(SandboxShapeSchema.safeParse({ memoryGib: 0, cpus: null, privileged: false, gpu: false }).success).toBe(false);
    expect(SandboxShapeSchema.safeParse({ memoryGib: null, cpus: null, privileged: false, gpu: false }).success).toBe(true);
});
