import { withSwitches } from "./commands.js";
import { profileFromBase64, supervisedByWindows, withChild, withoutChild } from "./machine.js";

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

    // The daily backup and the daily tidy are switches of their own, stored the same way beside the update ones.
    it("stores the backup and tidy switches off under their own keys, and on as their absence", () => {
        const off = withSwitches({ sandboxUpdates: false }, { backups: "off", tidy: "off" });
        expect(off).toEqual({ sandboxUpdates: false, sandboxBackups: false, sandboxTidy: false });
        expect(withSwitches(off, { backups: "on" })).toEqual({ sandboxUpdates: false, sandboxTidy: false });
    });
});

// cmd's echo of %USERPROFILE% arrived in the OEM code page; base64 of the UTF-8 arrives the same in every code page.
describe("profileFromBase64", () => {
    it("reads a profile with Polish letters in it as Windows names it", () => {
        const profile = "C:\\Users\\Zażółć Gęślą";
        expect(profileFromBase64(`${Buffer.from(profile, "utf8").toString("base64")}\r\n`)).toBe(profile);
    });

    it("answers nothing for what is not base64", () => {
        expect(profileFromBase64("")).toBeUndefined();
        expect(profileFromBase64("C:\\Users\\dev")).toBeUndefined();
        expect(profileFromBase64("powershell.exe : The term is not recognized")).toBeUndefined();
    });
});
