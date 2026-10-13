import { honouredPolicy } from "./honoured.js";

// What a runtime is handed of the turn's permission mode, pinned on the rule rather than on whichever real runtime is
// plan-only this week: runtimes gain approval modes as their seams are wired, and a test borrowing one stops testing the
// plan-only answer the day it does.

const asking = (permissionMode?: "default" | "plan" | "bypassPermissions") => ({ policy: permissionMode === undefined ? {} : { permissionMode } });

test("a plan-only runtime keeps `plan` and is handed no other permission mode", () => {
    expect(honouredPolicy(asking("default"), { permissions: "plan" })).toEqual({});
    expect(honouredPolicy(asking("bypassPermissions"), { permissions: "plan" })).toEqual({});
    expect(honouredPolicy(asking("plan"), { permissions: "plan" })).toEqual({ permissionMode: "plan" });
});

test("a runtime that holds approval modes is handed whichever the turn asked for", () => {
    for (const mode of ["default", "plan", "bypassPermissions"] as const) {
        expect(honouredPolicy(asking(mode), { permissions: "modes" })).toEqual({ permissionMode: mode });
    }
});

test("a turn that asked for no mode hands none on", () => {
    expect(honouredPolicy(asking(), { permissions: "modes" })).toEqual({});
});
