import { environmentName, machinePresence } from "./hosts.js";

// One answer to "does this computer answer", read by /capabilities, the Devices board and a call's routing alike
// (2026-10-13/15: one PC was offline on the card, live on the board, and partly connected by a third reading).

const side = (key: string, online: boolean) => ({ key, online });

test("a PC whose native side answers is online, whatever its distros do", () => {
    expect(machinePresence([side("native", true), side("wsl:archlinux", false)])).toEqual({ kind: "online" });
    expect(machinePresence([side("native", true), side("wsl:archlinux", true)])).toEqual({ kind: "online" });
});

test("a PC answering only through its distros is partly connected, and names them in order", () => {
    expect(machinePresence([side("native", false), side("wsl:ubuntu", true), side("wsl:archlinux", true)])).toEqual({
        kind: "partly",
        awake: ["wsl:archlinux", "wsl:ubuntu"],
    });
});

test("a computer nothing of which answers is offline", () => {
    expect(machinePresence([side("native", false), side("wsl:archlinux", false)])).toEqual({ kind: "offline" });
    expect(machinePresence([])).toEqual({ kind: "offline" });
});

// A machine seen only through a distro's sync has no native side to be missing.
test("a computer with no native side is online while anything of it answers", () => {
    expect(machinePresence([side("wsl:archlinux", true)])).toEqual({ kind: "online" });
});

test("names a distro the way WSL and `in` do", () => {
    expect(environmentName("wsl:archlinux")).toBe("archlinux");
    expect(environmentName("native")).toBe("native");
});
