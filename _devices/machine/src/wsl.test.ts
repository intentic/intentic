import { describe, it, expect } from "bun:test";
import { wslFrom } from "./wsl.js";

// The one fact that keeps a Windows install and the distros it hosts from collapsing into a single row: they all
// answer `hostname` with the same string, so a wrong answer here merges two machines or splits one.
describe("wslFrom", () => {
    const ARCH = `NAME="Arch Linux"\nID=arch\n`;
    const WSL2 = "Linux version 6.18.33.2-microsoft-standard-WSL2";
    const BARE = "Linux version 6.11.0-9-generic";

    it("takes WSL's own name for the distro, which is the one `wsl -l` shows", () => {
        expect(wslFrom(WSL2, "Arch", ARCH)).toEqual({ distro: "Arch" });
    });

    // THE REGISTRATION NAME, and the reason this source exists: a resident agent started from a login entry has no
    // WSL_DISTRO_NAME, and os-release says "Arch Linux" where `wsl -l -q` says "archlinux" — the mismatch that had a
    // connected distro listed as not connected, and `in: "wsl:Arch Linux"` refused by wsl.exe.
    it("takes the name WSL registered over anything the distro calls itself", () => {
        expect(wslFrom(WSL2, undefined, ARCH, "\\\\wsl.localhost\\archlinux\\\n")).toEqual({ distro: "archlinux" });
        // Older builds answer with the `wsl$` share instead.
        expect(wslFrom(WSL2, undefined, ARCH, "\\\\wsl$\\Ubuntu-22.04\\")).toEqual({ distro: "Ubuntu-22.04" });
        // It outranks the environment too: same string when both are there, and the one that is right when they differ.
        expect(wslFrom(WSL2, "Arch Linux", ARCH, "\\\\wsl.localhost\\archlinux\\")).toEqual({ distro: "archlinux" });
    });

    // Interop off, no wslpath, or a path that is not a distro share: names nothing, and the fallbacks answer.
    it("ignores an answer that is not a distro share", () => {
        expect(wslFrom(WSL2, "archlinux", ARCH, "C:\\Users\\radar")).toEqual({ distro: "archlinux" });
        expect(wslFrom(WSL2, undefined, ARCH, "")).toEqual({ distro: "Arch Linux" });
    });

    // The daemon case with no registration name to be had: what the distro calls itself, which is better than nothing.
    it("recognises the kernel with no distro name in the environment", () => {
        expect(wslFrom(WSL2, undefined, ARCH)).toEqual({ distro: "Arch Linux" });
    });

    // WSL1's kernel string says "Microsoft" rather than "microsoft-standard-WSL2".
    it("recognises WSL1's kernel too", () => {
        expect(wslFrom("Linux version 4.4.0-19041-Microsoft", undefined, ARCH)).toEqual({ distro: "Arch Linux" });
    });

    // Nothing else sets this, so it stands on its own where /proc could not be read.
    it("trusts the environment variable when the kernel string is missing", () => {
        expect(wslFrom(undefined, "Ubuntu-22.04", undefined)).toEqual({ distro: "Ubuntu-22.04" });
    });

    // Presence is the fact that matters; a distro that won't name itself is still a distro.
    it("carries an unknown distro as empty rather than guessing one", () => {
        expect(wslFrom(WSL2, undefined, undefined)).toEqual({ distro: "" });
    });

    it("says nothing on a Linux machine that is not WSL", () => {
        expect(wslFrom(BARE, undefined, ARCH)).toBeUndefined();
    });

    // Windows and macOS have neither path, so both reads come back undefined.
    it("says nothing where /proc does not exist at all", () => {
        expect(wslFrom(undefined, undefined, undefined)).toBeUndefined();
    });

    // An empty or whitespace-only variable is not a name, and must not be read as "this is WSL".
    it("ignores an empty distro variable", () => {
        expect(wslFrom(BARE, "   ", ARCH)).toBeUndefined();
    });
});
