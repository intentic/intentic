import { describe, expect, it } from "bun:test";
import { withSwitches } from "./commands.js";
import { supervisedByWindows, withChild, withoutChild } from "./machine.js";

describe("the children registry", () => {
    it("adds a distro once, sorted, and removes it without leaving an empty list behind", () => {
        const one = withChild({}, "archlinux");
        const two = withChild(withChild(one, "Ubuntu"), "archlinux");
        expect(two.children).toEqual(["Ubuntu", "archlinux"].toSorted());
        expect(withoutChild(withoutChild(two, "Ubuntu"), "archlinux")).toEqual({});
    });

    it("keeps every other setting when the registry changes", () => {
        expect(withoutChild({ children: ["archlinux"], agentUpdates: false }, "archlinux")).toEqual({ agentUpdates: false });
    });
});

describe("supervisedByWindows", () => {
    // Only the Windows side sets it, on the one process it runs in a distro; nothing else may claim that role.
    it("is true only for the value the Windows side sets", () => {
        expect(supervisedByWindows({ INTENTIC_MACHINE_SUPERVISOR: "windows" })).toBe(true);
        expect(supervisedByWindows({ INTENTIC_MACHINE_SUPERVISOR: "systemd" })).toBe(false);
        expect(supervisedByWindows({})).toBe(false);
    });
});

describe("withSwitches", () => {
    // On is the resting state, so it is the absence of the key: a config written before a switch existed reads the same.
    it("stores only an explicit off, and turning a switch on removes it", () => {
        const off = withSwitches({ children: ["archlinux"] }, { agent: "off" });
        expect(off).toEqual({ children: ["archlinux"], agentUpdates: false });
        expect(withSwitches(off, { agent: "on", sandboxes: "off" })).toEqual({ children: ["archlinux"], sandboxUpdates: false });
    });

    it("leaves a switch nobody named as it was", () => {
        expect(withSwitches({ agentUpdates: false }, { sandboxes: "on" })).toEqual({ agentUpdates: false });
    });
});
