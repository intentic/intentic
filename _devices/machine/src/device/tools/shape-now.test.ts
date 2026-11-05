import type { DeviceSandbox } from "@intentic/sandbox-contract/schemas/devices";
import { fleetFrom } from "./sandboxes.js";
import { swapOnlyNow } from "./shape-now.js";

// The machine agent says "nothing was restarted" exactly when ic applies the swap live: the swap is all that differs from
// what runs, once the fields are laid over what is saved for the next restart.

const FULL = { memoryGib: 18, cpus: null, privileged: false, gpu: false, swapGib: null };

// One row as `ic sandbox list --json` prints it (its text, as the agent receives it), read the way the agent reads every
// listing. `runs` is the shape the container runs with, `saved` the one saved for its next restart.
const listed = (running: boolean, runs: object = FULL, saved?: object): DeviceSandbox => {
    const desired = saved === undefined ? "" : `,"desired":${JSON.stringify(saved)}`;
    const line = `[{"slug":"work","container":"intentic-sandbox-work","running":${running},"image":"img:1","resources":{"privileged":false,"gpu":false,"hostRuntime":[],"overlayRuntime":[],"shape":${JSON.stringify(runs)}${desired}}}]`;
    const [read] = fleetFrom(line);
    if (read === undefined) {
        throw new Error("the listing did not read");
    }
    return read;
};

test("the swap alone, named alone or in a whole shape, is a change without a restart", () => {
    expect(swapOnlyNow(listed(true), { swapGib: 4 })).toBe(true);
    expect(swapOnlyNow(listed(true), { ...FULL, swapGib: 2 })).toBe(true);
});

test("anything else, or nothing at all, is the restart it always was", () => {
    expect(swapOnlyNow(listed(true), { swapGib: null })).toBe(false);
    expect(swapOnlyNow(listed(true), { memoryGib: 20, swapGib: 4 })).toBe(false);
    // A stopped sandbox is started onto it: a restart.
    expect(swapOnlyNow(listed(false), { swapGib: 4 })).toBe(false);
    // A shape saved for the next restart that changes the memory rides on any restart, so it is not the swap alone.
    expect(swapOnlyNow(listed(true, FULL, { ...FULL, memoryGib: 20 }), { swapGib: 4 })).toBe(false);
    // An ic older than the swap reports none: it restarts for any change, and is not said to do otherwise.
    const { swapGib: _unreported, ...older } = FULL;
    expect(swapOnlyNow(listed(true, older), { swapGib: 4 })).toBe(false);
});
