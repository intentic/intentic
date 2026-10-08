import { windowsRunDeleteArgs } from "@intentic/local-agent";
import type { UpkeepItem } from "./reconcile.js";
import { reportOf, summaryLine } from "./reconcile.js";
import { itemLine } from "./doctor.js";
import { isInside, trashedAt, trashStamp } from "./trash.js";
import { loginEntryFinding, mutagenRunDecision, runValueData } from "./login.js";
import { MANIFEST } from "./manifest.js";
import { expiredTrash, isShimPart, TRASH_KEEP_MS } from "./retention.js";
import { legacyAutostart } from "./retired.js";
import { shadowLine } from "./second-ic.js";

/* The device upkeep's DECISIONS, pure over what each entry reads: no file system, no registry, no ic. What happens on a
   real tree is upkeep.integration.test.ts. */

const NOW = Date.parse("2026-10-05T22:45:00.000Z");
const DAY = 24 * 60 * 60_000;

test("every entry has an id of its own, since the id names its marker for good", () => {
    const ids = MANIFEST.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("retired-login-entries");
});

/* The entries retired are named exactly as the two agents before this one registered them (commit 7c015ae734 removed
   their specs): a name off by a letter removes nothing and leaves the retired binary starting at every sign-in. */
test("the retired login entries are intentic-host's and the sync mirror's, under the names they registered", () => {
    const specs = legacyAutostart("/home/dev/.intentic/machine");
    expect(specs.map((spec) => [spec.id, spec.windowsRunValue, spec.launchAgent?.label])).toEqual([
        ["intentic-host", "IntenticHost", undefined],
        ["intentic-sync-mirror", "IntenticSyncMirror", "dev.intentic.sync-mirror"],
    ]);
    expect(specs.map((spec) => windowsRunDeleteArgs(spec)[3])).toEqual(["IntenticHost", "IntenticSyncMirror"]);
});

test("a trash entry's age is read off the stamp its name begins with, in either of the two shapes it is written", () => {
    const stamp = trashStamp(NOW);
    expect(stamp).toBe("2026-10-05T22-45-00-000Z");
    expect(trashedAt(stamp)).toBe(NOW);
    expect(trashedAt(`${stamp}-sync`)).toBe(NOW);
    expect(trashedAt("notes.txt")).toBeUndefined();
});

test("the trash keeps 30 days from when a thing went in, and never guesses at an undated name", () => {
    const old = trashStamp(NOW - 31 * DAY);
    const older = `${trashStamp(NOW - 40 * DAY)}-host`;
    expect(expiredTrash([old, older, `${trashStamp(NOW - 29 * DAY)}-sync`, "by-hand"], NOW)).toEqual({ expired: [older, old], undated: ["by-hand"] });
    expect(expiredTrash([trashStamp(NOW - TRASH_KEEP_MS)], NOW).expired).toHaveLength(1);
});

test("only the install command's half downloads are pruned from bin/, never the agent's own staged files", () => {
    expect(["intentic-machine.part-1.326.0", "intentic-machine.part", "intentic-launch.exe.part-1.2.3"].every(isShimPart)).toBe(true);
    expect(["intentic-machine", "intentic-machine.new-1.326.0", "intentic-machine.previous", "mutagen.tar.gz", "partner"].some(isShimPart)).toBe(
        false,
    );
});

test("a path is inside a folder only at a separator, so a link to a neighbour of the same prefix is not taken", () => {
    expect(isInside("/home/dev/.intentic/sync/bin/intentic-sync", "/home/dev/.intentic/sync")).toBe(true);
    expect(isInside("/home/dev/.intentic/sync", "/home/dev/.intentic/sync")).toBe(true);
    expect(isInside("/home/dev/.intentic/sync-elsewhere/bin", "/home/dev/.intentic/sync")).toBe(false);
});

// The deliberate rule of the start's repair holds here too: an entry launching another install's command is its own.
test("this agent's login entry is written again when stale or missing, left when current or another install's, and said when unreadable", () => {
    const repair = async (): Promise<void> => await Promise.resolve();
    expect(loginEntryFinding({ kind: "task", state: "stale", drift: ["arguments", "restart"] }, repair)?.what).toBe(
        'the "IntenticMachine" logon task (differs in arguments, restart)',
    );
    expect(loginEntryFinding({ kind: "systemd", state: "missing" }, repair)?.act).toBe(repair);
    expect(loginEntryFinding({ kind: "systemd", state: "foreign" }, repair)).toBeUndefined();
    expect(loginEntryFinding({ kind: "launchd", state: "current" }, repair)).toBeUndefined();
    expect(loginEntryFinding({ kind: "task", state: "unknown" }, repair)).toEqual({
        what: 'the "IntenticMachine" logon task',
        why: "it could not be read, so it is left as it is",
    });
});

test("a Run value is read out of what reg query prints", () => {
    const printed = [
        "",
        "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        '    IntenticMutagenDaemon    REG_SZ    "C:\\Users\\dev\\.intentic\\machine\\bin\\intentic-launch.exe" "--log" "x" "--" "C:\\Users\\dev\\.intentic\\machine\\bin\\mutagen.exe" "daemon" "start"',
        "",
    ].join("\r\n");
    expect(runValueData(printed, "IntenticMutagenDaemon")).toBe(
        '"C:\\Users\\dev\\.intentic\\machine\\bin\\intentic-launch.exe" "--log" "x" "--" "C:\\Users\\dev\\.intentic\\machine\\bin\\mutagen.exe" "daemon" "start"',
    );
    expect(runValueData(printed, "IntenticMachine")).toBeUndefined();
});

test("Mutagen's Run value goes once no pairing needs it, is written while one does and this agent's copy runs, else is left", () => {
    const own = "C:\\Users\\dev\\.intentic\\machine\\bin\\mutagen.exe";
    const ours = `"C:\\Users\\dev\\.intentic\\machine\\bin\\intentic-launch.exe" "--" "${own}" "daemon" "start"`;
    expect(mutagenRunDecision({ pairings: 0, value: ours, own, ownInUse: true })).toBe("retire");
    expect(mutagenRunDecision({ pairings: 0, value: undefined, own, ownInUse: true })).toBeUndefined();
    expect(mutagenRunDecision({ pairings: 2, value: undefined, own, ownInUse: true })).toBe("repair");
    expect(mutagenRunDecision({ pairings: 2, value: '"C:\\old\\mutagen.exe" "daemon" "start"', own, ownInUse: true })).toBe("repair");
    expect(mutagenRunDecision({ pairings: 2, value: ours.toUpperCase(), own, ownInUse: true })).toBeUndefined();
    // The user's own Mutagen is theirs to start.
    expect(mutagenRunDecision({ pairings: 2, value: undefined, own, ownInUse: false })).toBeUndefined();
    // A sync.json that does not read says nothing about whether a pairing needs it: nothing goes on a guess.
    expect(mutagenRunDecision({ pairings: new SyntaxError("bad json"), value: ours, own, ownInUse: true })).toEqual({
        why: "sync.json does not read (bad json), so whether a pairing needs it is not known",
    });
});

test("a second ic is reported with both versions", () => {
    expect(shadowLine("/usr/local/bin/ic", "1.300.0", "1.326.0")).toBe(
        "a second ic at /usr/local/bin/ic (version 1.300.0) shadows the agent's (1.326.0); it cannot be updated from here without sudo",
    );
});

const item = (overrides: Partial<UpkeepItem>): UpkeepItem => ({
    id: "retired-generations",
    kind: "retired-files",
    action: "trash",
    what: "/x",
    outcome: "fixed",
    ...overrides,
});

test("a pass is counted by kind, found and fixed, with every line it left and why", () => {
    const items = [
        item({ what: "/home/dev/.intentic/sync" }),
        item({ what: "/home/dev/.intentic/host", outcome: "skipped", why: "a program from it is running (pid 42)" }),
        item({ id: "machine-trash", kind: "trash", action: "prune", what: "/t/old" }),
        item({ id: "second-ic", kind: "ic", action: "report", what: "/usr/local/bin/ic", outcome: "skipped", why: "a second ic" }),
    ];
    const report = reportOf(items, NOW, "1.327.0");
    expect(report).toEqual({
        at: NOW,
        version: "1.327.0",
        found: { "retired-files": 2, trash: 1, ic: 1 },
        fixed: { "retired-files": 1, trash: 1 },
        skipped: [
            { kind: "retired-files", what: "/home/dev/.intentic/host", why: "a program from it is running (pid 42)" },
            { kind: "ic", what: "/usr/local/bin/ic", why: "a second ic" },
        ],
    });
    expect(summaryLine(report, true)).toBe(
        "upkeep: found 4 (retired-files 2, trash 1, ic 1), fixed 2, skipped 2: /home/dev/.intentic/host (a program from it is running (pid 42)); /usr/local/bin/ic (a second ic)",
    );
    expect(summaryLine(reportOf([], NOW, "1.327.0"), true)).toBe("upkeep: nothing left over from older releases, and every store within its bounds.");
});

test("doctor says each line in the words of what is, or would be, done", () => {
    expect(itemLine(item({ outcome: "would-fix" }))).toBe("  would move to the trash: /x");
    expect(itemLine(item({}))).toBe("  moved to the trash: /x");
    expect(itemLine(item({ outcome: "skipped", why: "in use" }))).toBe("  left: /x — in use");
});
