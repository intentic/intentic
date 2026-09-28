import { errorMessage } from "@intentic/base/errors";
import { plural } from "@intentic/base/format";
import type { Log } from "@intentic/local-agent";
import type { DeviceSandbox } from "@intentic/sandbox-contract";
import { z } from "zod";
import { readMachineConfig } from "../../environments/machine.js";
import { type IcRun, lastLine, newRoundState, type RoundState, type Rounds, runRound, startRounds } from "./ic-rounds.js";
import { fleet, icInFlight, runIc } from "../tools/sandboxes.js";

// A copy of every sandbox on this machine once a day: `ic sandbox backup <slug> --auto` writes an encrypted,
// incremental backup beside the sandbox's data, and decides everything itself (skipped when one ran in the last day or
// so, when the disk is low, or while a swap is in flight). This file only keeps the clock, one sandbox at a time, and
// backs off from a sandbox whose backups keep failing, as auto-prepare does.

// Well clear of boot and of auto-prepare's first pull (auto-prepare.ts): twenty to forty minutes after start.
const FIRST_TICK_MS = 20 * 60_000;
const FIRST_SPREAD_MS = 20 * 60_000;
// Daily, jittered so a fleet's machines do not all read their disks in the same minute.
const TICK_MS = 24 * 60 * 60_000;
const JITTER_MS = 60 * 60_000;

// Running sandboxes only (a stopped one has not changed since its last copy) and never a runner, whose /work is a
// mirror of its parent's git and comes back from there. A parked one is down mid-swap: ic would skip it anyway.
export const backupTargets = (boxes: readonly DeviceSandbox[]): string[] =>
    boxes.filter((box) => box.running && box.parked !== true && !box.slug.startsWith("runner-")).map((box) => box.slug);

// `--auto` is what lets ic say "not now"; `--json` is the one line this reads back.
export const autoBackupArgs = (slug: string): string[] => ["sandbox", "backup", slug, "--auto", "--json"];

// What `ic sandbox backup --json` answers, one line of it. `result` is ic's word, read as a string so a new one is
// still reported rather than dropped.
const BackupAnswerSchema = z.object({
    slug: z.string(),
    result: z.string(),
    snapshot: z.string().optional(),
    reason: z.string().optional(),
});

const backupAnswer = (line: string): z.infer<typeof BackupAnswerSchema> | undefined => {
    try {
        const parsed = BackupAnswerSchema.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is ic's prose, which the fallback below reports as it is
        return undefined;
    }
};

// The sentence a finished backup is logged as: ic's own answer when it gave one, else its last line.
export const backupNews = (slug: string, output: string): string => {
    const answer = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map(backupAnswer)
        .findLast((found) => found !== undefined);
    if (answer === undefined) {
        return `auto-backup ${slug}: ${lastLine(output) ?? "done"}`;
    }
    const detail = answer.result === "done" ? answer.snapshot : answer.reason;
    return `auto-backup ${slug}: ${answer.result}${detail === undefined ? "" : ` (${detail})`}`;
};

export const newBackupState = (): RoundState => newRoundState();

// Split from the scheduler so the decisions are asserted with a fake backup, no timers and no ic.
export const runBackupRound = async (
    state: RoundState,
    boxes: readonly DeviceSandbox[],
    backup: (slug: string) => Promise<IcRun>,
    log: Log,
    busy: ReadonlySet<string> = icInFlight,
): Promise<void> =>
    await runRound(state, backupTargets(boxes), { name: "auto-backup", run: backup, said: (slug, run) => backupNews(slug, run.output) }, log, busy);

/* THE DAILY TIDY, after the backups: `ic sandbox tidy` clears what swaps and removals leave behind on this machine (images
   no sandbox can go back to any more, records of sandboxes that are gone, the trash past its week). It never deletes a
   volume; one no sandbox claims is only named, so a person can decide. */

export const autoTidyArgs = (): string[] => ["sandbox", "tidy", "--json"];

// What `ic sandbox tidy --json` answers. Each list defaults to empty, so an ic that leaves one out reads as "none".
const TidyAnswerSchema = z.object({
    images: z.array(z.string()).default([]),
    records: z.array(z.string()).default([]),
    purgedFromTrash: z.array(z.string()).default([]),
    orphanVolumes: z.array(z.string()).default([]),
});

const tidyAnswer = (line: string): z.infer<typeof TidyAnswerSchema> | undefined => {
    try {
        const parsed = TidyAnswerSchema.safeParse(JSON.parse(line));
        return parsed.success ? parsed.data : undefined;
    } catch {
        // allow(silent-catch): a line that is not JSON is ic's prose, which the fallback below reports as it is
        return undefined;
    }
};

// One line for the whole tidy: what went, in counts, and the volumes nobody claims by name, since those stay.
export const tidyNews = (run: IcRun): string => {
    const answer = run.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("{"))
        .map(tidyAnswer)
        .findLast((found) => found !== undefined);
    if (run.code !== 0 || answer === undefined) {
        return `auto-tidy: ${run.code === 0 ? "" : "failed — "}${lastLine(run.output) ?? "no output"}`;
    }
    const removed = [
        answer.images.length === 0 ? undefined : plural(answer.images.length, "image"),
        answer.records.length === 0 ? undefined : `${plural(answer.records.length, "record")} of sandboxes that are gone`,
        answer.purgedFromTrash.length === 0 ? undefined : `${plural(answer.purgedFromTrash.length, "sandbox", "sandboxes")} from the trash`,
    ].filter((part) => part !== undefined);
    const kept = answer.orphanVolumes.length === 0 ? "" : `; volumes no sandbox claims, kept for you to decide: ${answer.orphanVolumes.join(", ")}`;
    return `auto-tidy: ${removed.length === 0 ? "nothing to clear" : `cleared ${removed.join(", ")}`}${kept}`;
};

// The tidy, when its switch is on. A throw (no ic at all) is a failed line like any other, since the round goes on.
export const runTidy = async (tidy: () => Promise<IcRun>, log: Log): Promise<void> => {
    try {
        log(tidyNews(await tidy()));
    } catch (error) {
        log(`auto-tidy: failed — ${errorMessage(error)}`);
    }
};

// Both switches (`intentic-machine updates --backups`, `--tidy`) are re-read every round; a config that does not read
// skips the round, since it may be the one holding them off.
export const startAutoBackup = (log: Log): Rounds => {
    const state = newBackupState();
    return startRounds(
        "auto-backup",
        log,
        FIRST_TICK_MS + Math.floor(Math.random() * FIRST_SPREAD_MS),
        () => TICK_MS + Math.floor(Math.random() * JITTER_MS),
        async () => {
            const config = await readMachineConfig();
            if (config.sandboxBackups !== false) {
                await runBackupRound(state, await fleet(), async (slug) => await runIc(autoBackupArgs(slug), () => undefined), log);
            }
            if (config.sandboxTidy !== false) {
                await runTidy(async () => await runIc(autoTidyArgs(), () => undefined), log);
            }
        },
    );
};
