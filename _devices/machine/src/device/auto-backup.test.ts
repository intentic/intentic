import type { DeviceSandbox } from "@intentic/sandbox-contract";
import { autoBackupArgs, autoTidyArgs, backupNews, backupTargets, newBackupState, runBackupRound, runTidy, tidyNews } from "./auto-backup.js";

/* The daily round's DECISIONS, without timers or an ic: which sandboxes it copies, and what each answer is logged as. */

const box = (slug: string, overrides: Partial<DeviceSandbox> = {}): DeviceSandbox => ({
    slug,
    container: `intentic-sandbox-${slug}`,
    running: true,
    image: "ghcr.io/intentic/sandbox:1",
    ...overrides,
});

test("only running, person-owned sandboxes are backed up: a stopped one has not changed, a parked one is mid-swap", () => {
    expect(backupTargets([box("work"), box("asleep", { running: false }), box("runner-abc123"), box("mid", { running: false, parked: true })])).toEqual([
        "work",
    ]);
});

// `--auto` is what lets ic decide "not now" (a copy in the last day, a low disk, a swap in flight) instead of asking.
test("the command line carries --auto and asks for the one JSON line this reads", () => {
    expect(autoBackupArgs("work")).toEqual(["sandbox", "backup", "work", "--auto", "--json"]);
    expect(autoTidyArgs()).toEqual(["sandbox", "tidy", "--json"]);
});

test("a backup is logged as ic answered it: the snapshot it wrote, or why it did not", () => {
    expect(backupNews("work", 'backing up…\n{"slug":"work","result":"done","snapshot":"5f2a","repo":"/r"}\n')).toBe("auto-backup work: done (5f2a)");
    expect(backupNews("work", '{"slug":"work","result":"skipped","reason":"one ran 3 hours ago"}')).toBe("auto-backup work: skipped (one ran 3 hours ago)");
    // An ic that printed prose instead is still heard, in its own last words.
    expect(backupNews("work", "intentic: backed up\n")).toBe("auto-backup work: intentic: backed up");
});

test("a round backs each target up once, and one that fails sits out the next round", async () => {
    const state = newBackupState();
    const ran: string[] = [];
    const lines: string[] = [];
    const round = async (): Promise<void> =>
        await runBackupRound(
            state,
            [box("one"), box("two")],
            async (slug) => {
                ran.push(slug);
                return await Promise.resolve(slug === "two" ? { code: 1, output: "disk full" } : { code: 0, output: '{"slug":"one","result":"done","snapshot":"a1"}' });
            },
            (line) => lines.push(line),
            new Set(),
        );
    await round();
    await round();
    expect(ran).toEqual(["one", "two", "one"]);
    expect(lines).toEqual([
        "auto-backup one: done (a1)",
        "auto-backup two: failed (attempt 1, retrying after 1 tick) — disk full",
        "auto-backup one: done (a1)",
    ]);
});

test("a sandbox a person's flow is touching is left for the next round", async () => {
    const ran: string[] = [];
    await runBackupRound(newBackupState(), [box("work"), box("other")], async (slug) => await Promise.resolve({ code: 0, output: `${ran.push(slug)}` }), () => undefined, new Set(["work"]));
    expect(ran).toEqual(["other"]);
});

// A volume is never deleted by the tidy, so the one line names the ones nobody claims: that is the owner's decision.
test("a tidy is one line of counts, with the volumes nobody claims named", () => {
    const answer = JSON.stringify({ dryRun: false, images: ["img:1", "img:2"], records: ["gone"], purgedFromTrash: [], orphanVolumes: ["intentic-old-work"] });
    expect(tidyNews({ code: 0, output: `${answer}\n` })).toBe(
        "auto-tidy: cleared 2 images, 1 record of sandboxes that are gone; volumes no sandbox claims, kept for you to decide: intentic-old-work",
    );
    expect(tidyNews({ code: 0, output: JSON.stringify({ dryRun: false, images: [], records: [], purgedFromTrash: ["a", "b"], orphanVolumes: [] }) })).toBe(
        "auto-tidy: cleared 2 sandboxes from the trash",
    );
    expect(tidyNews({ code: 0, output: '{"dryRun":false}' })).toBe("auto-tidy: nothing to clear");
    expect(tidyNews({ code: 1, output: "docker is not running\n" })).toBe("auto-tidy: failed — docker is not running");
});

test("a tidy that throws (no ic on this machine) is a failed line, not a round that dies", async () => {
    const lines: string[] = [];
    await runTidy(async () => await Promise.reject(new Error("This device has no `ic` command")), (line) => lines.push(line));
    expect(lines).toEqual(["auto-tidy: failed — This device has no `ic` command"]);
});
