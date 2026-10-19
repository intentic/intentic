import { NOT_ON_MAC } from "@intentic/keyring";
import { supportOf } from "./keyring-status.js";
import { approvalRefused, elevatedCommand, NEEDS_ADMIN } from "./service.js";

/* Whether Passwords can be set up here, and how its one administrator's yes is asked: UAC on Windows, pkexec on Linux.
   Neither prompt is shown here. */

const BIN = "/opt/bin";
const everything = { PATH: BIN };

describe("whether Passwords can be set up here", () => {
    test("Windows can; macOS cannot, saying so in a sentence", () => {
        expect(supportOf("win32")).toEqual({ canSetUp: true, platform: "windows" });
        expect(supportOf("darwin")).toEqual({ canSetUp: false, why: NOT_ON_MAC, platform: "darwin" });
    });

    test("Linux needs systemd running and polkit, naming what is missing", () => {
        const none = supportOf("linux", { PATH: "/nonexistent" }, () => false);
        expect(none.canSetUp).toBe(false);
        expect(none.why).toContain("systemd running as this computer's init");
        expect(none.why).toContain("polkit (pkexec)");
        expect(supportOf("linux", everything, () => true).platform).toBe("linux");
    });
});

describe("the administrator's yes", () => {
    test("is pkexec running the keyring itself on Linux, and UAC through Start-Process on Windows", () => {
        const linux = elevatedCommand(["service", "install"], "linux");
        expect(linux.command).toBe("pkexec");
        expect(linux.args.slice(-2)).toEqual(["service", "install"]);
        const windows = elevatedCommand(["service", "install"], "win32");
        expect(windows.command).toBe("powershell.exe");
        expect(windows.args.at(-1)).toContain("-Verb RunAs");
    });

    test("not given reads as such: pkexec's 126 and 127, UAC's cancel", () => {
        expect(approvalRefused(126, "", "linux")).toBe(true);
        expect(approvalRefused(127, "", "linux")).toBe(true);
        expect(approvalRefused(1, "", "linux")).toBe(false);
        expect(approvalRefused(1, "The operation was canceled by the user.", "win32")).toBe(true);
        expect(NEEDS_ADMIN).toContain("administrator's approval once");
    });
});
