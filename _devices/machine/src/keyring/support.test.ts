import { NOT_ON_MAC,KeyringUnavailable } from "@intentic/keyring";
import { supportOf,keyringLine } from "./keyring-status.js";
import { approvalRefused, elevatedCommand, elevatedScriptCommand, NEEDS_ADMIN, nobodyToAsk, serviceDown } from "./service.js";

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
        // The elevated keyring is a console program: without this, Windows opens a cmd window in the person's face.
        expect(windows.args.at(-1)).toContain("-WindowStyle Hidden");
    });

    test("runs a script as sh under pkexec, and as PowerShell's encoded command through UAC", () => {
        expect(elevatedScriptCommand("systemctl stop x", "linux")).toEqual({ command: "pkexec", args: ["sh", "-c", "systemctl stop x"] });
        const windows = elevatedScriptCommand("Stop-ScheduledTask -TaskName 'x'", "win32").args.at(-1) ?? "";
        expect(windows).toContain("-Verb RunAs");
        // Encoded, so no quote in the script can end the outer command's string.
        expect(windows).toContain(`'-EncodedCommand','${Buffer.from("Stop-ScheduledTask -TaskName 'x'", "utf16le").toString("base64")}'`);
    });

    test("not given reads as such: pkexec's 126 and 127, UAC's cancel", () => {
        expect(approvalRefused(126, "", "linux")).toBe(true);
        expect(approvalRefused(127, "", "linux")).toBe(true);
        expect(approvalRefused(1, "", "linux")).toBe(false);
        expect(approvalRefused(1, "The operation was canceled by the user.", "win32")).toBe(true);
        expect(NEEDS_ADMIN).toContain("administrator's approval once");
    });
});

describe("a service installed and silent", () => {
    test("is the helper answering no-keyring, not a keyring that is down or refusing something else", () => {
        expect(serviceDown({ ok: false, code: "no-keyring", refusal: "Passwords' service is not running yet." })).toBe(true);
        expect(serviceDown({ ok: false, code: "locked", refusal: "Locked." })).toBe(false);
        expect(serviceDown(new KeyringUnavailable("no pipe"))).toBe(false);
    });

    test("reads as a failure that names the repair, not as a keyring waiting to be set up", () => {
        const line = keyringLine({ installed: true, running: true, setUp: false, serviceDown: true });
        expect(line.tone).toBe("fail");
        expect(line.meta).toContain("keyring upgrade");
    });
});

describe("an update the keyring cannot ask about", () => {
    test("is a no that nobody was there to give, which the administrator's yes stands in for", () => {
        expect(
            nobodyToAsk({
                ok: false,
                refusal: "Nobody could be asked: no passphrase prompt could be shown: nobody is signed in to ask: Passwords' session helper starts at sign-in.",
            }),
        ).toBe(true);
        expect(nobodyToAsk({ ok: false, refusal: "You said no to updating the keyring." })).toBe(false);
    });
});

describe("a keyring that does not answer where its service is installed", () => {
    test("reads as not running and how to start it, never as waiting to be set up", () => {
        const line = keyringLine({ installed: true, running: false, setUp: false, serviceInstalled: true });
        expect(line.tone).toBe("fail");
        expect(line.meta).toContain("keyring start");
        expect(line.meta).not.toContain("keyring setup");
    });
});
