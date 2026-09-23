import { UPGRADE_ENV } from "./environments/machine-upgrade.js";
import { addToWindowsPathValue, selfUpdateBeforeSetup, type SelfUpdateIo } from "./install.js";
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
