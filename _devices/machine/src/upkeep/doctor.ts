import { buildCommand, type CommandContext } from "@stricli/core";
import { readResident } from "../supervision.js";
import { MANIFEST } from "./manifest.js";
import { runUpkeep, summaryLine, type UpkeepItem, type UpkeepOutcome } from "./reconcile.js";

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

// One line per thing found, in the words of what is (or would be) done with it. Pure.
export const itemLine = (item: UpkeepItem): string => {
    const said: Readonly<Record<UpkeepOutcome, string>> = {
        fixed: `${DONE[item.action]}: ${item.what}`,
        "would-fix": `would ${VERB[item.action]}: ${item.what}`,
        skipped: `left: ${item.what} — ${item.why ?? ""}`,
    };
    return `  ${said[item.outcome]}`;
};

// Why each kind of thing goes, said once per entry that found something. Pure.
const reasonLines = (items: readonly UpkeepItem[]): string[] =>
    MANIFEST.filter((entry) => items.some((item) => item.id === entry.id)).map((entry) => `  ${entry.id}: ${entry.reason}`);

export const doctor = buildCommand<DoctorFlags>({
    docs: { brief: "Check this environment for what older releases left and stores past their bounds; --fix puts it right" },
    parameters: {
        flags: {
            fix: { kind: "boolean", brief: "Do what the check finds, as the agent's own pass every six hours would", default: false },
            json: { kind: "boolean", brief: "Print one JSON object: the counts, and every line found", default: false },
        },
    },
    async func(this: CommandContext, flags: DoctorFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const resident = await readResident();
        const run = await runUpkeep({ fix: flags.fix, resident: false, supervisor: resident?.supervisor, log: flags.json ? () => undefined : out });
        if ("busy" in run) {
            const why = `the agent's own upkeep pass is running (pid ${run.busy}); try again in a minute.`;
            if (flags.json) {
                out(JSON.stringify({ ok: false, error: why }));
            } else {
                out(why);
            }
            process.exitCode = 1;
            return;
        }
        if (flags.json) {
            out(JSON.stringify({ ok: true, fix: flags.fix, ...run.report, items: run.items }));
            return;
        }
        for (const item of run.items) {
            out(itemLine(item));
        }
        const reasons = reasonLines(run.items);
        if (reasons.length > 0) {
            out("Why:");
            for (const line of reasons) {
                out(line);
            }
        }
        out(summaryLine(run.report, flags.fix));
        if (!flags.fix && run.items.some((item) => item.outcome === "would-fix")) {
            out("Run `intentic-machine doctor --fix` to do it now; the agent does it by itself within six hours.");
        }
    },
});
