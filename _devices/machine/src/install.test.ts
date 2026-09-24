import { UPGRADE_ENV } from "./environments/machine-upgrade.js";
import { addToWindowsPathValue, selfUpdateBeforeSetup, type SelfUpdateIo, windowsPathFrom } from "./install.js";
import type { UpgradeOutcome } from "./upgrade.js";

const io = (
    overrides: Partial<SelfUpdateIo> & { outcome?: UpgradeOutcome } = {},
): { io: SelfUpdateIo; upgraded: () => boolean; reexeced: () => readonly string[] | undefined; reexecedAs: () => string | undefined } => {
    let ran = false;
    let reexecArgs: readonly string[] | undefined;
    let reexecVersion: string | undefined;
    const built: SelfUpdateIo = {
        installed: overrides.installed ?? "1.2.3",
        installedAgent: overrides.installedAgent ?? (() => true),
        upgrade:
            overrides.upgrade ??
            (async () => {
                ran = true;
                return await Promise.resolve(overrides.outcome ?? { kind: "current", version: "1.2.3" });
            }),
        reexec:
            overrides.reexec ??
            ((args, version): never => {
                reexecArgs = args;
                reexecVersion = version;
                // The real one replaces the process; the test one has to stop the caller the same way.
                throw new Error("reexec");
            }),
    };
    return { io: built, upgraded: () => ran, reexeced: () => reexecArgs, reexecedAs: () => reexecVersion };
};

describe("selfUpdateBeforeSetup", () => {
    // The same variable marks setup's own re-exec and one leg of a machine-wide upgrade: either is already an update.
    it("skips under the re-exec guard, so an updated agent never updates again", async () => {
        const t = io();
        await selfUpdateBeforeSetup(t.io, { [UPGRADE_ENV]: "1.3.0" }, ["device", "setup"], () => undefined);
        expect(t.upgraded()).toBe(false);
    });

    it("never replaces a source build under whoever is dogfooding it", async () => {
        const t = io({ installed: "0.0.0" });
        await selfUpdateBeforeSetup(t.io, {}, ["device", "setup"], () => undefined);
        expect(t.upgraded()).toBe(false);
    });

    it("leaves a dev run (node dist/cli.js, AGENT_BIN) entirely alone", async () => {
        const t = io({ installedAgent: () => false });
        await selfUpdateBeforeSetup(t.io, {}, ["device", "setup"], () => undefined);
        expect(t.upgraded()).toBe(false);
    });

    it("re-execs the new agent with the same argv after an actual update", async () => {
        const t = io({ outcome: { kind: "upgraded", from: "1.2.3", to: "1.3.0" } });
        const args = ["device", "setup", "--url", "https://s.example", "--pair", "p"];
        await expect(selfUpdateBeforeSetup(t.io, {}, args, () => undefined)).rejects.toThrow("reexec");
        expect(t.reexeced()).toEqual(args);
        // Carried to the re-exec, which is how that run knows to bring the rest of the PC to the same release.
        expect(t.reexecedAs()).toBe("1.3.0");
    });

    it("notes a failed update and continues — the pairing token expires, the enrollment must not", async () => {
        const installed = "1.2.3";
        const reason = "the download failed";
        const lines: string[] = [];
        const t = io({ installed, outcome: { kind: "failed", reason } });
        await selfUpdateBeforeSetup(t.io, {}, ["sync", "setup"], (line) => lines.push(line));
        expect(t.reexeced()).toBeUndefined();
        const joined = lines.join("\n");
        expect(joined).toContain(installed);
        expect(joined).toContain(reason);
    });

    it("says nothing and continues when already current", async () => {
        const out = jest.fn();
        const t = io();
        await selfUpdateBeforeSetup(t.io, {}, ["sync", "setup"], out);
        expect(t.upgraded()).toBe(true);
        expect(out).not.toHaveBeenCalled();
    });
});

describe("addToWindowsPathValue", () => {
    it("appends a missing folder and keeps every existing entry, tokens included", () => {
        expect(addToWindowsPathValue(String.raw`%USERPROFILE%\bin;C:\tools`, String.raw`C:\Users\a\.intentic\machine\bin`)).toBe(
            String.raw`%USERPROFILE%\bin;C:\tools;C:\Users\a\.intentic\machine\bin`,
        );
    });

    it("answers undefined when the folder is already there, comparing the way PowerShell's -contains did (case-insensitively)", () => {
        expect(addToWindowsPathValue(String.raw`C:\USERS\A\.INTENTIC\MACHINE\BIN`, String.raw`C:\Users\a\.intentic\machine\bin`)).toBeUndefined();
    });

    it("drops empty entries left by doubled or trailing semicolons instead of writing them back", () => {
        expect(addToWindowsPathValue(String.raw`C:\one;;C:\two;`, String.raw`C:\three`)).toBe(String.raw`C:\one;C:\two;C:\three`);
    });

    it("starts a PATH that was empty or unset", () => {
        expect(addToWindowsPathValue("", String.raw`C:\bin`)).toBe(String.raw`C:\bin`);
    });
});

// What is read here is written back whole, so every reading that is not the user's PATH as stored would replace it.
describe("windowsPathFrom", () => {
    const listing = (...rows: string[]): string => ["", String.raw`HKEY_CURRENT_USER\Environment`, ...rows, ""].join("\r\n");

    it("reads the value and keeps its kind", () => {
        expect(
            windowsPathFrom(listing(String.raw`    TEMP    REG_EXPAND_SZ    %USERPROFILE%\AppData\Local\Temp`, String.raw`    Path    REG_EXPAND_SZ    %USERPROFILE%\bin;C:\tools`)),
        ).toEqual({ kind: "REG_EXPAND_SZ", stored: String.raw`%USERPROFILE%\bin;C:\tools` });
    });

    it("finds a value spelled PATH, since Windows names are case-insensitive and reg add /v Path would replace it", () => {
        expect(windowsPathFrom(listing(String.raw`    PATH    REG_SZ    C:\tools`))).toEqual({ kind: "REG_SZ", stored: String.raw`C:\tools` });
    });

    it("does not take a value whose name only starts with Path for the PATH", () => {
        expect(windowsPathFrom(listing(String.raw`    Path Backup    REG_SZ    C:\old`))).toEqual({ kind: "REG_EXPAND_SZ", stored: "" });
    });

    it("reads an empty value as empty and an absent one as an empty REG_EXPAND_SZ", () => {
        expect(windowsPathFrom(listing("    Path    REG_SZ    "))).toEqual({ kind: "REG_SZ", stored: "" });
        expect(windowsPathFrom(listing())).toEqual({ kind: "REG_EXPAND_SZ", stored: "" });
    });

    it("refuses a PATH of a kind it would not write back the same", () => {
        expect(() => windowsPathFrom(listing(String.raw`    Path    REG_MULTI_SZ    C:\one\0C:\two`))).toThrow(
            "your PATH is stored as REG_MULTI_SZ, which this installer does not rewrite",
        );
    });
});
