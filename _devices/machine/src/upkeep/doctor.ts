import type { CommandContext } from "@stricli/core";
import { explain, type Item } from "@intentic/local-agent";
import { answeringUi, buildCommand, markFailed } from "../cli-ui.js";
import { readResident } from "../supervision.js";
import { MANIFEST } from "./manifest.js";
import { runUpkeep, summaryLine, type UpkeepItem } from "./reconcile.js";

/* `intentic-machine doctor [--fix] [--json]`: the resident's upkeep pass (reconcile.ts), on demand. Without `--fix` it
   only lists what the pass would do, and changes nothing, not even upkeep.json. With it, it does what the resident
   would, under the same lock, and writes upkeep.json as a pass of the resident does. `--json` prints one object, the
   shape of upkeep.json plus `fix` and every `items` line, for whatever reads it; fields are only ever added. */

interface DoctorFlags {
    readonly fix: boolean;
    readonly json: boolean;
}

const VERB: Readonly<Record<UpkeepItem["action"], string>> = {
    retire: "retire",
    trash: "move to the trash",
    prune: "delete",
    rotate: "set aside",
    repair: "write again",
    report: "report",
};

const DONE: Readonly<Record<UpkeepItem["action"], string>> = {
    retire: "retired",
    trash: "moved to the trash",
    prune: "deleted",
    rotate: "set aside",
    repair: "written again",
    report: "reported",
};

// One row per thing found: the thing, and what is (or would be) done with it. Pure.
export const doctorItem = (item: UpkeepItem): Item => {
    switch (item.outcome) {
        case "fixed":
            return { tone: "ok", name: item.what, meta: DONE[item.action] };
        case "would-fix":
            return { tone: "warn", name: item.what, meta: `would ${VERB[item.action]}` };
        default:
            return { tone: "skip", name: item.what, meta: `left: ${item.why ?? "no reason given"}` };
    }
};

// Why each kind of thing goes, said once per entry that found something. Pure.
export const reasonLines = (items: readonly UpkeepItem[]): string[] =>
    MANIFEST.filter((entry) => items.some((item) => item.id === entry.id)).map((entry) => `${entry.id}: ${entry.reason}`);

export const doctor = buildCommand<DoctorFlags>({
    docs: { brief: "Check this environment for what older releases left and stores past their bounds; --fix puts it right" },
    parameters: {
        flags: {
            fix: { kind: "boolean", brief: "Do what the check finds, as the agent's own pass every six hours would", default: false },
            json: { kind: "boolean", brief: "Print one JSON object: the counts, and every line found", default: false },
        },
    },
    async func(this: CommandContext, flags: DoctorFlags) {
        const ui = answeringUi(this.process, flags.json);
        const resident = await readResident();
        if (!flags.json) {
            ui.report("intentic · doctor", flags.fix ? "fixing what it finds" : "checking only: nothing is changed");
        }
        const run = await runUpkeep({
            fix: flags.fix,
            resident: false,
            supervisor: resident?.supervisor,
            log: flags.json ? () => undefined : ui.note,
        });
        if ("busy" in run) {
            const why = `the agent's own upkeep pass is running (pid ${run.busy})`;
            if (!flags.json) {
                throw new Error(explain("The check did not run.", `${why}.`, "run the same command again in a minute."));
            }
            // allow(terminal-output): the --json failure object
            this.process.stdout.write(`${JSON.stringify({ ok: false, error: `The check did not run: ${why}; try again in a minute.` })}\n`);
            markFailed(this);
            return;
        }
        if (flags.json) {
            // allow(terminal-output): the --json document
            this.process.stdout.write(`${JSON.stringify({ ok: true, fix: flags.fix, ...run.report, items: run.items })}\n`);
            return;
        }
        const summary = summaryLine(run.report, flags.fix);
        if (run.items.length === 0) {
            ui.quiet("Nothing is left over from older releases, and every store is within its bounds.");
            ui.plain(summary);
            return;
        }
        ui.items(run.items.map(doctorItem));
        const reasons = reasonLines(run.items);
        if (reasons.length > 0) {
            ui.section("why");
            for (const line of reasons) {
                ui.note(line);
            }
        }
        // A log reads the counts as one line; a screen has just listed them.
        ui.plain(summary);
        if (!flags.fix && run.items.some((item) => item.outcome === "would-fix")) {
            ui.note("The agent does it by itself within six hours.");
            ui.later([["do it now", "intentic-machine doctor --fix"]]);
        }
    },
});
