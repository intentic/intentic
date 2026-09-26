import { DeviceSandboxFlowSchema, icForgetShapeArgs, icPowerArgs, icShapeArgs, SandboxShapeSchema } from "./devices.js";

// The one spelling of ic's shape and power verbs outside ic: the machine agent runs these and the Devices view prints them for a
// person to type, so a drift here is a command that fails on the machine, or one that does something else there.

test("a whole shape is one `--set` per field, in the contract's own names and values", () => {
    expect(icShapeArgs("work", { memoryGib: 20, cpus: null, privileged: false, gpu: true }, "nextRestart")).toEqual([
        "sandbox",
        "shape",
        "work",
        "--set",
        "memoryGib=20",
        "--set",
        "cpus=null",
        "--set",
        "privileged=false",
        "--set",
        "gpu=true",
        "--when",
        "nextRestart",
    ]);
    expect(icShapeArgs("work", { memoryGib: null, cpus: 4, privileged: true, gpu: false }, "now").slice(3)).toEqual([
        "--set",
        "memoryGib=null",
        "--set",
        "cpus=4",
        "--set",
        "privileged=true",
        "--set",
        "gpu=false",
        "--when",
        "now",
    ]);
});

test("a field left out is left to ic, which keeps what it has for it", () => {
    expect(icShapeArgs("work", { memoryGib: 12, gpu: undefined }, "now")).toEqual(["sandbox", "shape", "work", "--set", "memoryGib=12", "--when", "now"]);
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

// Every device input is strict, the shape nested in one included: an agent that dropped a field it did not know would
// carry out a different order than the one sent.
test("a device order refuses a shape or delta field it does not know", () => {
    const whole = { memoryGib: 20, cpus: null, privileged: false, gpu: false };
    // As the order arrives off the wire, where the nested object is only ever JSON.
    const accepted = (fields: object): boolean =>
        DeviceSandboxFlowSchema.safeParse(JSON.parse(`{"op":"set-shape","slug":"work","when":"now","shape":${JSON.stringify(fields)}}`)).success;
    expect(accepted(whole)).toBe(true);
    expect(accepted({ ...whole, swapGib: 4 })).toBe(false);
    expect(DeviceSandboxFlowSchema.safeParse({ op: "reshape", slug: "work", resources: { memoryGib: 20, swapGib: 4 } }).success).toBe(false);
    // A report is read leniently: a newer ic's extra field must not fail an older reader.
    expect(SandboxShapeSchema.safeParse({ ...whole, swapGib: 4 }).success).toBe(true);
});
