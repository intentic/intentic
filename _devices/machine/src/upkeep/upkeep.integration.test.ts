import { spawn } from "node:child_process";
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    symlinkSync,
    utimesSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimPidFile } from "@intentic/local-agent";
import { rollAudit } from "../device/audit.js";
import type { UpkeepContext, UpkeepEntry } from "./entry.js";
import { trashStamp } from "./files.js";
import { readUpkeepSummary, reconcile, runUpkeep } from "./reconcile.js";
import { RETENTION_ENTRIES } from "./retention.js";
import { linkWatchEntry, RETIRED_ENTRIES } from "./retired.js";

/* The device upkeep on a real tree: a home of its own per test, holding what an old install leaves, and the passes run
   over it as the resident runs them. Nothing outside the temp folder is touched (the entries that ask the OS about login
   entries are left out). */

const root = realpathSync(mkdtempSync(join(tmpdir(), "machine-upkeep-")));
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-05T22:45:00.000Z");
const DAY = 24 * 60 * 60_000;

let made = 0;
const home = (): { readonly context: UpkeepContext; readonly lines: string[] } => {
    made += 1;
    const dir = join(root, `home-${made}`);
    const base = join(dir, ".intentic", "machine");
    mkdirSync(base, { recursive: true });
    const lines: string[] = [];
    return {
        context: { log: (line) => lines.push(line), now: NOW, home: dir, base, platform: "linux", supervisor: undefined, resident: true },
        lines,
    };
};

const entry = (entries: readonly UpkeepEntry[], id: string): UpkeepEntry => {
    const found = entries.find((each) => each.id === id);
    if (found === undefined) {
        throw new Error(`no entry ${id}`);
    }
    return found;
};

const write = (path: string, text = "x"): void => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
};

test("the retired agents' folders, their links on PATH and the set-aside sync.json go to the trash; a link pointing elsewhere stays", async () => {
    const { context } = home();
    const { home: dir, base } = context;
    write(join(dir, ".intentic", "sync", "bin", "intentic-sync"));
    write(join(dir, ".intentic", "host", "intentic-host"));
    mkdirSync(join(dir, ".local", "bin"), { recursive: true });
    symlinkSync(join(dir, ".intentic", "sync", "bin", "intentic-sync"), join(dir, ".local", "bin", "intentic-sync"));
    symlinkSync("/usr/bin/true", join(dir, ".local", "bin", "intentic-host"));
    write(join(base, "sync.json.bak-loopback"), "{}");
    const generations = [entry(RETIRED_ENTRIES, "retired-generations")];

    // A dry run lists, and moves nothing.
    const dry = await reconcile(generations, context, { fix: false });
    expect(dry.map((item) => [item.what.slice(dir.length), item.outcome])).toEqual([
        ["/.intentic/host", "would-fix"],
        ["/.intentic/sync", "would-fix"],
        ["/.local/bin/intentic-sync", "would-fix"],
        ["/.intentic/machine/sync.json.bak-loopback", "would-fix"],
    ]);
    expect(existsSync(join(dir, ".intentic", "sync"))).toBe(true);

    const fixed = await reconcile(generations, context, { fix: true });
    expect(fixed.every((item) => item.outcome === "fixed")).toBe(true);
    const stamp = trashStamp(NOW);
    expect(readdirSync(join(base, "trash")).toSorted()).toEqual([
        `${stamp}-host`,
        `${stamp}-intentic-sync`,
        `${stamp}-sync`,
        `${stamp}-sync.json.bak-loopback`,
    ]);
    expect(readFileSync(join(base, "trash", `${stamp}-sync`, "bin", "intentic-sync"), "utf8")).toBe("x");
    expect(existsSync(join(dir, ".local", "bin", "intentic-host"))).toBe(true);
    // Converged: the next pass finds nothing.
    expect(await reconcile(generations, context, { fix: true })).toEqual([]);
});

test("a retired folder a program still runs from is left, with the pid, until it stops", async () => {
    const { context } = home();
    const bin = join(context.home, ".intentic", "host", "bin");
    mkdirSync(bin, { recursive: true });
    copyFileSync("/bin/sleep", join(bin, "intentic-host"));
    const child = spawn(join(bin, "intentic-host"), ["30"], { stdio: "ignore" });
    try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const items = await reconcile([entry(RETIRED_ENTRIES, "retired-generations")], context, { fix: true });
        expect(items).toEqual([
            {
                id: "retired-generations",
                kind: "retired-files",
                action: "trash",
                what: join(context.home, ".intentic", "host"),
                outcome: "skipped",
                why: `a program from it is running (pid ${child.pid}); it is moved once that has stopped`,
            },
        ]);
        expect(existsSync(bin)).toBe(true);
    } finally {
        child.kill("SIGKILL");
    }
});

test("the link-watch workaround's timer, unit, wants link and script all go to the trash, none over another", async () => {
    const { context } = home();
    const units = join(context.home, ".config", "systemd", "user");
    write(join(units, "intentic-link-watch.timer"), "timer");
    write(join(units, "intentic-link-watch.service"), "service");
    mkdirSync(join(units, "timers.target.wants"), { recursive: true });
    symlinkSync(join(units, "intentic-link-watch.timer"), join(units, "timers.target.wants", "intentic-link-watch.timer"));
    write(join(context.home, ".local", "bin", "intentic-link-watch"), "#!/bin/sh");
    const asked: string[] = [];
    const items = await reconcile([linkWatchEntry((...args) => void asked.push(args.join(" ")))], context, { fix: true });
    expect(items.map((item) => [item.what, item.outcome])).toEqual([["intentic-link-watch (4 files)", "fixed"]]);
    // Turned off before its files go, and systemd told to forget it after.
    expect(asked).toEqual(["disable --now intentic-link-watch.timer", "stop intentic-link-watch.service", "daemon-reload"]);
    const trashed = readdirSync(join(context.base, "trash")).toSorted();
    expect(trashed).toHaveLength(4);
    const stamp = trashStamp(NOW);
    expect(readFileSync(join(context.base, "trash", `${stamp}-intentic-link-watch.timer`), "utf8")).toBe("timer");
    expect(existsSync(join(units, "intentic-link-watch.timer"))).toBe(false);
});

test("the trash keeps what went in within 30 days and what carries no date, and deletes the rest", async () => {
    const { context, lines } = home();
    const trash = join(context.base, "trash");
    write(join(trash, `${trashStamp(NOW - 31 * DAY)}`, "notes.txt"));
    write(join(trash, `${trashStamp(NOW - 2 * DAY)}-sync`, "big"));
    write(join(trash, "by-hand", "kept"));
    const items = await reconcile([entry(RETENTION_ENTRIES, "machine-trash")], context, { fix: true });
    expect(items.map((item) => item.outcome)).toEqual(["fixed", "skipped"]);
    expect(readdirSync(trash).toSorted()).toEqual([`${trashStamp(NOW - 2 * DAY)}-sync`, "by-hand"].toSorted());
    expect(lines).toEqual([]);
});

test("the audit record is set aside once it reaches its bound, by the writer's own roll and by the upkeep alike", async () => {
    const { context } = home();
    const audit = join(context.base, "audit.jsonl");
    writeFileSync(audit, "a".repeat(20));
    expect(await rollAudit(audit, 100)).toBe(false);
    expect(await rollAudit(audit, 20)).toBe(true);
    expect(readFileSync(`${audit}.1`, "utf8")).toHaveLength(20);
    expect(existsSync(audit)).toBe(false);

    writeFileSync(audit, Buffer.alloc(8 * 1024 * 1024, 0x61));
    const items = await reconcile([entry(RETENTION_ENTRIES, "audit-log")], context, { fix: true });
    expect(items.map((item) => item.outcome)).toEqual(["fixed"]);
    expect(existsSync(audit)).toBe(false);
    expect(readFileSync(`${audit}.1`).length).toBe(8 * 1024 * 1024);
});

test("a half download the install command left a day ago is deleted; today's, and the agent's own files, are not", async () => {
    const { context } = home();
    const bin = join(context.base, "bin");
    write(join(bin, "intentic-machine.part-1.300.0"));
    write(join(bin, "intentic-machine.part"));
    write(join(bin, "intentic-machine.part-1.326.0"));
    write(join(bin, "intentic-machine"));
    const old = (NOW - 2 * DAY) / 1000;
    utimesSync(join(bin, "intentic-machine.part-1.300.0"), old, old);
    utimesSync(join(bin, "intentic-machine.part"), old, old);
    utimesSync(join(bin, "intentic-machine"), old, old);
    const fresh = NOW / 1000;
    utimesSync(join(bin, "intentic-machine.part-1.326.0"), fresh, fresh);
    await reconcile([entry(RETENTION_ENTRIES, "bin-part-files")], context, { fix: true });
    expect(readdirSync(bin).toSorted()).toEqual(["intentic-machine", "intentic-machine.part-1.326.0"]);
});

/* Markers, one per entry: an entry a later release adds runs on a machine that holds every older marker. */

const counting = (id: string, finds: () => readonly { what: string; fail?: boolean }[]): UpkeepEntry & { readonly acted: string[] } => {
    const acted: string[] = [];
    return {
        id,
        kind: "test",
        action: "retire",
        reason: "a test",
        once: true,
        ...(id === "migrated" ? { formerMarker: "legacy-autostart-retired" } : {}),
        acted,
        find: async () =>
            await Promise.resolve(
                finds().map(({ what, fail }) => ({
                    what,
                    act: async () => {
                        if (fail === true) {
                            throw new Error("refused");
                        }
                        acted.push(what);
                        return await Promise.resolve();
                    },
                })),
            ),
    };
};

test("a once-only entry runs until nothing it found is left, then never again; the old single marker counts for its own work only", async () => {
    const { context } = home();
    writeFileSync(join(context.base, "legacy-autostart-retired"), "2026-08-29\n");
    const migrated = counting("migrated", () => [{ what: "old entry" }]);
    let failing = true;
    const later = counting("added-later", () => [{ what: "new thing", fail: failing }]);

    // The old marker stands in for the entry it was written for, and a dry run moves nothing.
    expect(await reconcile([migrated, later], context, { fix: false })).toEqual([
        { id: "added-later", kind: "test", action: "retire", what: "new thing", outcome: "would-fix" },
    ]);
    expect(existsSync(join(context.base, "legacy-autostart-retired"))).toBe(true);

    // A finding that could not be acted on leaves the entry to run again.
    const first = await reconcile([migrated, later], context, { fix: true });
    expect(first.map((item) => [item.id, item.outcome, item.why])).toEqual([["added-later", "skipped", "refused"]]);
    expect(migrated.acted).toEqual([]);
    expect(existsSync(join(context.base, "upkeep", "migrated"))).toBe(true);
    expect(existsSync(join(context.base, "legacy-autostart-retired"))).toBe(false);
    expect(existsSync(join(context.base, "upkeep", "added-later"))).toBe(false);

    failing = false;
    await reconcile([migrated, later], context, { fix: true });
    expect(later.acted).toEqual(["new thing"]);
    expect(await reconcile([migrated, later], context, { fix: true })).toEqual([]);
    expect(later.acted).toEqual(["new thing"]);
});

test("an entry that cannot look costs its own line, and the pass goes on", async () => {
    const { context } = home();
    const broken: UpkeepEntry = {
        id: "broken",
        kind: "test",
        action: "prune",
        reason: "a test",
        find: async () => await Promise.reject(new Error("EACCES")),
    };
    const fine = counting("fine", () => [{ what: "thing" }]);
    const items = await reconcile([broken, fine], context, { fix: true });
    expect(items.map((item) => [item.id, item.outcome, item.why])).toEqual([
        ["broken", "skipped", "could not look: EACCES"],
        ["fine", "fixed", undefined],
    ]);
});

test("a pass that fixes writes upkeep.json, the facts carry at most ten of its skipped lines, and a dry run writes nothing", async () => {
    const { context } = home();
    const many: UpkeepEntry = {
        id: "many",
        kind: "test",
        action: "report",
        reason: "a test",
        find: async () => await Promise.resolve(Array.from({ length: 12 }, (_, n) => ({ what: `thing ${n}`, why: "only a person can" }))),
    };
    const options = {
        resident: true,
        supervisor: undefined,
        log: () => undefined,
        entries: [many],
        home: context.home,
        base: context.base,
        now: NOW,
    };
    await runUpkeep({ ...options, fix: false });
    expect(existsSync(join(context.base, "upkeep.json"))).toBe(false);
    const run = await runUpkeep({ ...options, fix: true });
    expect("report" in run && run.report.skipped).toHaveLength(12);
    const written = JSON.parse(readFileSync(join(context.base, "upkeep.json"), "utf8")) as { version: string; found: unknown };
    expect(written.found).toEqual({ test: 12 });
    const summary = await readUpkeepSummary(context.base);
    expect(summary?.skipped).toHaveLength(10);
    expect(summary).toMatchObject({ at: NOW, found: { test: 12 }, fixed: {} });
    expect(summary).not.toHaveProperty("version");
});

test("a pass that fixes waits for no one: another one running is answered with its pid", async () => {
    const { context } = home();
    const holder = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
        await claimPidFile(join(context.base, "upkeep.pid"), context.base, { pid: holder.pid ?? 0 });
        const run = await runUpkeep({
            fix: true,
            resident: false,
            supervisor: undefined,
            log: () => undefined,
            entries: [],
            home: context.home,
            base: context.base,
        });
        expect(run).toEqual({ busy: holder.pid ?? 0 });
    } finally {
        holder.kill("SIGKILL");
    }
});
