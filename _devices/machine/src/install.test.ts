import { UPGRADE_ENV } from "./environments/machine-upgrade.js";
import {
    addToWindowsPathValue,
    type CurrentCheck,
    CURRENT_FOR_MS,
    recentlyCurrent,
    removeFromWindowsPathValue,
    selfUpdateBeforeSetup,
    type SelfUpdateIo,
    windowsPathFrom,
} from "./install.js";
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
        checkedCurrent: overrides.checkedCurrent ?? (async () => await Promise.resolve(undefined)),
        rememberCurrent: overrides.rememberCurrent ?? (async () => await Promise.resolve()),
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

    // (2026-10-21) An EPERM thrown out of the agent's swap ended a folder's setup before it paired, though the agent
    // already installed could pair it. A thrown update reads as a failed one.
    it("notes an update that throws and continues with the installed agent", async () => {
        const lines: string[] = [];
        const t = io({
            installed: "1.346.0",
            upgrade: async () =>
                await Promise.reject(new Error("EPERM: operation not permitted, rename 'intentic-launch.exe' -> 'intentic-launch.exe.previous'")),
        });
        await expect(selfUpdateBeforeSetup(t.io, {}, ["sync", "setup"], (line) => lines.push(line))).resolves.toBeUndefined();
        expect(t.reexeced()).toBeUndefined();
        expect(lines).toEqual([
            "Couldn't update the agent first (EPERM: operation not permitted, rename 'intentic-launch.exe' -> 'intentic-launch.exe.previous'); continuing with 1.346.0.",
        ]);
    });

    // (2026-10-21) `ic` runs sync setup and device setup back to back for every new sandbox: the second asks nothing when
    // the first found this same release the newest moments ago, and an older finding, or another release's, is asked again.
    it("asks the release channel once for two setups minutes apart, and keeps what it found", async () => {
        let kept: CurrentCheck | undefined;
        const t = io({
            checkedCurrent: async () => await Promise.resolve(kept),
            rememberCurrent: async (check) => {
                kept = check;
                await Promise.resolve();
            },
        });
        await selfUpdateBeforeSetup(t.io, {}, ["sync", "setup"], () => undefined, 1_000_000);
        expect(t.upgraded()).toBe(true);
        expect(kept).toEqual({ version: "1.2.3", at: 1_000_000 });
        const second = io({ checkedCurrent: async () => await Promise.resolve(kept) });
        await selfUpdateBeforeSetup(second.io, {}, ["device", "setup"], () => undefined, 1_000_000 + 60_000);
        expect(second.upgraded()).toBe(false);
    });

    it("reads a finding as current only for the same release and only for a while", () => {
        const check = { version: "1.2.3", at: 1_000 };
        expect(recentlyCurrent(check, "1.2.3", 1_000 + CURRENT_FOR_MS - 1)).toBe(true);
        expect(recentlyCurrent(check, "1.2.3", 1_000 + CURRENT_FOR_MS)).toBe(false);
        expect(recentlyCurrent(check, "1.2.4", 1_001)).toBe(false);
        expect(recentlyCurrent(check, "1.2.3", 999)).toBe(false);
        expect(recentlyCurrent(undefined, "1.2.3", 1_001)).toBe(false);
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
// The mirror `uninstall --purge` runs: the caller writes the answer back under the kind it read (windowsPathFrom).
describe("removeFromWindowsPathValue", () => {
    const BIN = String.raw`C:\Users\a\.intentic\machine\bin`;

    it("takes the folder out and keeps every other entry as it was, tokens included", () => {
        expect(removeFromWindowsPathValue(String.raw`%USERPROFILE%\bin;C:\Users\a\.intentic\machine\bin;C:\tools`, BIN)).toBe(String.raw`%USERPROFILE%\bin;C:\tools`);
    });

    it("matches the whole entry case-insensitively, a trailing backslash not counting, and every copy of it", () => {
        expect(removeFromWindowsPathValue(`${String.raw`C:\USERS\A\.INTENTIC\MACHINE\BIN;C:\tools;`}${BIN}\\`, BIN)).toBe(String.raw`C:\tools`);
    });

    it("leaves a longer path that only starts with the folder, and a folder inside it, alone", () => {
        expect(removeFromWindowsPathValue(String.raw`C:\Users\a\.intentic\machine\bin2;C:\Users\a\.intentic\machine\bin\sub`, BIN)).toBeUndefined();
    });

    it("answers undefined when the folder is not there, so nothing is written back", () => {
        expect(removeFromWindowsPathValue(String.raw`C:\one;;C:\two;`, BIN)).toBeUndefined();
        expect(removeFromWindowsPathValue("", BIN)).toBeUndefined();
    });

    it("keeps the user's own empty entries where they were, and empties a PATH that held only the folder", () => {
        expect(removeFromWindowsPathValue(String.raw`C:\one;;C:\Users\a\.intentic\machine\bin;C:\two;`, BIN)).toBe(String.raw`C:\one;;C:\two;`);
        expect(removeFromWindowsPathValue(BIN, BIN)).toBe("");
    });
});

describe("windowsPathFrom", () => {
    it("keeps the value as stored, unexpanded and in any language, and its kind", () => {
        expect(windowsPathFrom({ kind: "REG_EXPAND_SZ", data: "%USERPROFILE%\\bin;C:\\Użytkownicy\\Zażółć\\narzędzia" })).toEqual({
            kind: "REG_EXPAND_SZ",
            stored: "%USERPROFILE%\\bin;C:\\Użytkownicy\\Zażółć\\narzędzia",
        });
        expect(windowsPathFrom({ kind: "REG_SZ", data: String.raw`C:\tools` })).toEqual({ kind: "REG_SZ", stored: String.raw`C:\tools` });
    });

    it("reads an empty value as empty and an absent one as an empty REG_EXPAND_SZ", () => {
        expect(windowsPathFrom({ kind: "REG_SZ", data: "" })).toEqual({ kind: "REG_SZ", stored: "" });
        expect(windowsPathFrom(undefined)).toEqual({ kind: "REG_EXPAND_SZ", stored: "" });
    });

    it("refuses a PATH of a kind it would not write back the same", () => {
        expect(() => windowsPathFrom({ kind: "REG_MULTI_SZ", data: String.raw`C:\one C:\two` })).toThrow(
            "your PATH is stored as REG_MULTI_SZ, which this installer does not rewrite",
        );
    });
});
