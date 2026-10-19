import {
    distroOutcome,
    holdingBack,
    keyringSweep,
    lingerAction,
    linkIsOurs,
    machineSweep,
    purgeChoice,
    sandboxTrashName,
    windowsCleanupScript,
} from "./plan.js";
import { stopOf, tally } from "./tally.js";

/* What `uninstall --purge` decides, pure: no file system, no registry, no process. What happens on a real tree is the
   removal itself, which no test runs against the home of whoever runs the suite. */

describe("purgeChoice", () => {
    it("is the plain uninstall without a flag, so nothing about it changes", () => {
        expect(purgeChoice({})).toEqual({ purge: false, deleteData: false });
        expect(purgeChoice({ purge: false, deleteData: false })).toEqual({ purge: false, deleteData: false });
    });

    it("purges with --purge, keeping the data", () => {
        expect(purgeChoice({ purge: true })).toEqual({ purge: true, deleteData: false });
    });

    it("purges with --delete-data alone, which implies --purge", () => {
        expect(purgeChoice({ deleteData: true })).toEqual({ purge: true, deleteData: true });
        expect(purgeChoice({ purge: true, deleteData: true })).toEqual({ purge: true, deleteData: true });
    });
});

const STAMP = "2026-10-05T22-45-00-000Z";

describe("machineSweep", () => {
    const names = ["bin", "mutagen", "machine.log", "device.json", "sync.json", "restore", "audit.jsonl", "audit.jsonl.1", "runs", "trash", "machine.json"];

    it("keeps the restore points and every audit log, and removes the rest", () => {
        const sweep = machineSweep(names, [], false);
        expect(sweep.keep).toEqual(["restore", "audit.jsonl", "audit.jsonl.1"]);
        expect(sweep.remove).toEqual(["bin", "mutagen", "machine.log", "device.json", "sync.json", "runs", "trash", "machine.json"]);
    });

    it("keeps what a sandbox moved to the trash and removes what the upkeep put there", () => {
        const sweep = machineSweep(["trash", "bin"], [STAMP, `${STAMP}-sync`, `${STAMP}-intentic-host`], false);
        expect(sweep.keep).toEqual([`trash/${STAMP}`]);
        expect(sweep.remove).toEqual([`trash/${STAMP}-sync`, `trash/${STAMP}-intentic-host`, "bin"]);
    });

    it("removes everything with --delete-data, data included", () => {
        expect(machineSweep(names, [STAMP], true)).toEqual({ remove: names, keep: [] });
    });

    it("never counts a name that only starts like the audit log's folder or the restore points as data", () => {
        expect(machineSweep(["restore-old", "audit"], [], false).keep).toEqual([]);
    });
});

describe("keyringSweep", () => {
    const names = ["vault.json", "keys.json", "audit.jsonl", "audit.jsonl.1", "keyring.log", "keyring.pid", "keyring.sock", "linger-enabled"];

    it("keeps the vault, its keys and its record: the passwords stay openable with the same passphrase", () => {
        expect(keyringSweep(names, false)).toEqual({
            remove: ["keyring.log", "keyring.pid", "keyring.sock", "linger-enabled"],
            keep: ["vault.json", "keys.json", "audit.jsonl", "audit.jsonl.1"],
        });
    });

    it("removes the vault too with --delete-data", () => {
        expect(keyringSweep(names, true)).toEqual({ remove: names, keep: [] });
    });
});

describe("holdingBack", () => {
    it("moves the held names from what goes to what stays, and nothing else", () => {
        expect(holdingBack({ remove: ["bin", "runs"], keep: ["restore"] }, ["bin"])).toEqual({ remove: ["runs"], keep: ["restore", "bin"] });
        expect(holdingBack({ remove: ["runs"], keep: [] }, ["bin"])).toEqual({ remove: ["runs"], keep: [] });
    });
});

describe("lingerAction", () => {
    it("turns lingering off only where the agent's marker says it turned it on", () => {
        expect(lingerAction(true, true)).toBe("disable");
    });

    it("leaves the user's own lingering on: on, with no marker of the agent's", () => {
        expect(lingerAction(false, true)).toBe("theirs");
    });

    it("has nothing to do where lingering is off, marker or not", () => {
        expect(lingerAction(true, false)).toBe("off");
        expect(lingerAction(false, false)).toBe("off");
    });

    it("decides nothing where lingering cannot be read", () => {
        expect(lingerAction(true, undefined)).toBe("unknown");
    });
});

describe("distroOutcome", () => {
    it("reads a distro's purge from its agent's exit code, as wsl.exe passes it through", () => {
        expect(distroOutcome(0)).toBe("purged");
        expect(distroOutcome(64)).toBe("no-agent");
        // stricli's InvalidArgument (-4) as a Linux exit status: an agent from before --purge.
        expect(distroOutcome(252)).toBe("older");
        expect(distroOutcome(1)).toBe("failed");
        // A deadline that stopped it.
        expect(distroOutcome(null)).toBe("failed");
    });
});

describe("linkIsOurs", () => {
    const bin = "/home/dev/.intentic/machine/bin";
    const agent = `${bin}/intentic-machine`;

    it("is the link that points at the agent, or anywhere in its bin folder, dangling or not", () => {
        expect(linkIsOurs(agent, agent, bin)).toBe(true);
        expect(linkIsOurs(`${bin}/intentic-machine.uninstalling`, agent, bin)).toBe(true);
    });

    it("is not a link of the same name pointing elsewhere, nor a plain file", () => {
        expect(linkIsOurs("/usr/local/bin/intentic-machine", agent, bin)).toBe(false);
        expect(linkIsOurs("/home/dev/.intentic/machine/bin2/intentic-machine", agent, bin)).toBe(false);
        expect(linkIsOurs(undefined, agent, bin)).toBe(false);
    });
});

describe("sandboxTrashName", () => {
    it("is a trash folder named for the moment alone, as trash_file names them", () => {
        expect(sandboxTrashName(STAMP)).toBe(true);
        expect(sandboxTrashName(`${STAMP}-sync`)).toBe(false);
        expect(sandboxTrashName("notes.txt")).toBe(false);
    });
});

describe("windowsCleanupScript", () => {
    const script = windowsCleanupScript(4242, [String.raw`C:\Users\a\.intentic\machine\bin`, String.raw`C:\Users\a\AppData\Local\Temp\intentic-machine-uninstalled-4242.exe`], [
        String.raw`C:\Users\a\.intentic\machine`,
        String.raw`C:\Users\a\.intentic`,
    ]);

    it("waits for this process before it removes anything", () => {
        expect(script.indexOf("Wait-Process -Id 4242")).toBeLessThan(script.indexOf("Remove-Item"));
    });

    it("names each path as a literal, so a quote in a profile's name cannot end it", () => {
        expect(windowsCleanupScript(1, [String.raw`C:\Users\O'Brien\.intentic\machine\bin`], [])).toContain(String.raw`'C:\Users\O''Brien\.intentic\machine\bin'`);
    });

    it("removes a folder at the end only when nothing is left in it, inner folders first", () => {
        expect(script).toContain("-not (Get-ChildItem -LiteralPath $d -Force)");
        expect(script.indexOf(String.raw`'C:\Users\a\.intentic\machine'`)).toBeLessThan(script.lastIndexOf(String.raw`'C:\Users\a\.intentic'`));
    });
});

describe("tally", () => {
    it("counts warnings, carries the fix on its own line, and keeps failures for the stop", () => {
        const said: string[] = [];
        const say = tally({ note: (text) => said.push(`note ${text}`), warn: (text) => said.push(`warn ${text}`) });
        say.note("Removed the keyring.");
        say.warn("Lingering stays on.", "loginctl disable-linger");
        say.warn("A sandbox still lists this device.");
        say.fail("the agent is still running (pid 7).", "kill 7");
        expect(said).toEqual(["note Removed the keyring.", "warn Lingering stays on.\n   fix:     loginctl disable-linger", "warn A sandbox still lists this device."]);
        expect(say.warnings()).toBe(2);
        expect(say.failures()).toEqual([{ problem: "the agent is still running (pid 7).", fix: "kill 7" }]);
    });

    it("numbers several failures in the stop, each with its own fix", () => {
        expect(stopOf("Not removed.", [{ problem: "a", fix: "x" }])).toBe("Not removed.\n   problem: a\n   fix:     x");
        expect(stopOf("Not removed.", [{ problem: "a", fix: "x" }, { problem: "b", fix: "y" }])).toBe(
            "Not removed.\n   problem: 1. a\n   fix:     x\n   problem: 2. b\n   fix:     y",
        );
    });
});
