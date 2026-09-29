import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
    MECHANISMS,
    measureExperiment,
    MIN_ARM_TURNS,
    type Design,
    type MeasuredTurn,
    type SampleUnit,
    type TurnExperiment,
    type TurnMetricReading,
} from "@intentic/agent-context/arm-stats";
import { readClaudeSession } from "@intentic/agent-context/claude-transcript";
import { DERIVED_DIR } from "@intentic/fileq/sidecar";
import { createTurnMetrics } from "@intentic/agent-context/turn-metrics";
import { parseStatsFile, summarizeStats, type SavingsSummary, type StatRow } from "@intentic/output-cleaners/stats";
import { loadOptions, OPTIONS, optionEnvName, type OptionKey, readOptions, type Options } from "./features.js";
import { outputDir } from "./post-bash.js";
import { isMissing, projectSlug } from "./runtime.js";
import { readSessions, type SessionRow } from "./sessions.js";

// /intentic:stats: what each mechanism saved, read off the plugin's own ledgers and the sessions' transcripts. The
// arithmetic is the sandbox's own (@intentic/output-cleaners' summarizeStats for the cleaners, @intentic/agent-context's
// arm-stats for the context mechanisms), so a number here means what the same number means on the sandbox's savings
// page. Printed as markdown Claude hands to the person as it is.

// The newest sessions a report reads back: enough for the arms to resolve, few enough to read in seconds.
const MAX_SESSIONS = 150;

export interface StatsArgs {
    readonly data: string;
    // The project to report on; undefined reports every project the plugin has seen.
    readonly project: string | undefined;
    readonly options: Options;
}

const tokens = (count: number): string => {
    if (count >= 1_000_000) {
        return `${(count / 1_000_000).toFixed(1)}M`;
    }
    if (count >= 10_000) {
        return `${Math.round(count / 1000)}k`;
    }
    return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count);
};

const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

// A ledger or log nothing has written yet reads as undefined; one that is there and unreadable fails the report aloud.
const readText = (path: string): string | undefined => {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return undefined;
        }
        throw error;
    }
};

// ---- the cleaners -------------------------------------------------------------------------------------------------

const cleanerLines = (summary: SavingsSummary, options: Options): string[] => {
    if (summary.commands === 0) {
        return [options.output_cleaners ? "No commands have been trimmed yet." : "Switched off (`output_cleaners` in /config)."];
    }
    const cleaned = summary.holdout.cleaned;
    const lines = [
        `${counted(cleaned, "command")} trimmed: ${tokens(summary.rawTokens)} tokens of output became ${tokens(summary.emittedTokens)} (${summary.savedPct}% saved, exact per command).`,
    ];
    const stages = summary.perCleaner.filter((stage) => stage.savedTokens > 0).slice(0, 6);
    if (stages.length > 0) {
        lines.push(`Biggest cleaners: ${stages.map((stage) => `${stage.id} ${tokens(stage.savedTokens)} (${counted(stage.commands, "command")})`).join(", ")}.`);
    }
    const { heldOut, measuredSavedPct } = summary.holdout;
    if (measuredSavedPct !== undefined) {
        lines.push(`Against ${counted(heldOut, "untrimmed command")}, the median output is ${measuredSavedPct}% smaller.`);
    } else if (heldOut > 0) {
        lines.push(`The untrimmed comparison has ${counted(heldOut, "command")}; it reports once it is large enough and the difference is clear.`);
    } else {
        lines.push("No commands are left untrimmed (`output_holdout` is 0), so the saving is exact per command but has no control group.");
    }
    const gaps = summary.gaps.slice(0, 3);
    if (gaps.length > 0) {
        lines.push(`Untouched and still costly: ${gaps.map((gap) => `\`${gap.command}\` ${tokens(gap.tokens)} over ${gap.commands}`).join(", ")}.`);
    }
    return lines;
};

// ---- the context mechanisms ---------------------------------------------------------------------------------------

interface PluginTurn extends MeasuredTurn {
    readonly mapArm?: boolean | undefined;
    readonly notesArm?: boolean | undefined;
    readonly iqArm?: boolean | undefined;
    readonly notesCohort?: string | undefined;
}

// A recorded session's turns, scored by the same ledger the sandbox scores a live turn with.
export const turnsOf = (row: SessionRow): PluginTurn[] => {
    if (row.transcript === undefined) {
        return [];
    }
    const session = readClaudeSession(row.transcript, { root: row.project });
    return (session?.turns ?? []).map((turn) => {
        const metrics = createTurnMetrics(row.project);
        const edited: string[] = [];
        for (const call of turn.calls) {
            metrics.call(call);
            if (call.category === "edit") {
                edited.push(...(call.locations ?? []).map((location) => location.path));
            }
        }
        for (const failure of turn.failures) {
            metrics.failed(failure.id);
        }
        return {
            conversationId: row.session,
            at: turn.at,
            turnIndex: turn.index,
            ...metrics.reading(edited),
            mapArm: row.arms.map,
            notesArm: row.arms.notes,
            iqArm: row.arms.iq,
            notesCohort: row.notesRevision,
        };
    });
};

const DESIGNS: readonly { readonly title: string; readonly option: keyof Options; readonly design: Design<PluginTurn>; readonly reads: string }[] = [
    { title: "Project map", option: "project_map", design: { ...MECHANISMS.map, arm: (turn) => turn.mapArm, cohort: () => undefined }, reads: "root listings in the opening turn" },
    {
        title: "Field notes",
        option: "field_notes",
        design: { ...MECHANISMS.notes, arm: (turn) => turn.notesArm, cohort: (turn) => turn.notesCohort },
        reads: "failed tool calls per turn",
    },
    { title: "iq teaching", option: "iq", design: { ...MECHANISMS.search, arm: (turn) => turn.iqArm, cohort: () => undefined }, reads: "search calls per turn" },
];

// Said the way the sandbox's savings chart says it: the change once the margin excludes zero, the margin in percentage
// points at 95%, and the two arms' means with the samples behind them.
const readingLine = (reading: TurnMetricReading, unit: SampleUnit): string => {
    const arms = `${reading.on.mean} with it vs ${reading.off.mean} without, over ${reading.on.turns} and ${reading.off.turns} ${unit}`;
    if (reading.deltaPct !== undefined && reading.marginPct !== undefined) {
        return `${reading.deltaPct > 0 ? "+" : ""}${reading.deltaPct}% ±${reading.marginPct}pp (95%): ${arms}.`;
    }
    if (reading.marginPct !== undefined) {
        return `no difference yet beyond ±${reading.marginPct}pp (95%): ${arms}.`;
    }
    return `measuring, ${Math.min(reading.on.turns, reading.off.turns)} of ${MIN_ARM_TURNS} ${unit} in the smaller arm: ${arms}.`;
};

const mechanismLine = (title: string, reads: string, on: boolean, experiment: TurnExperiment | undefined, holdout: number): string => {
    if (!on) {
        return `${title}: switched off.`;
    }
    if (holdout === 0) {
        return `${title}: on for every session; nothing is held out (\`holdout\` is 0), so there is nothing to compare.`;
    }
    if (experiment === undefined) {
        return `${title}: no measured sessions yet.`;
    }
    return `${title}, ${reads}: ${readingLine(experiment.metrics[0], experiment.sampleUnit ?? "conversations")}`;
};

// ---- shadows ------------------------------------------------------------------------------------------------------

const countShadows = (dir: string): number => {
    let count = 0;
    const walk = (current: string): void => {
        let entries;
        try {
            entries = readdirSync(current, { withFileTypes: true });
        } catch (error) {
            if (isMissing(error)) {
                return;
            }
            throw error;
        }
        for (const entry of entries) {
            if (entry.isDirectory()) {
                walk(join(current, entry.name));
            } else if (entry.name.endsWith(".md")) {
                count += 1;
            }
        }
    };
    walk(dir);
    return count;
};

// The last sweep's own summary (`fileq sweep --json`), said in words; nothing when it has not run or did not finish.
const lastSweep = (data: string, project: string): string => {
    const text = readText(join(data, "shadows", `${projectSlug(project)}.sweep.log`));
    try {
        const summary = JSON.parse(text ?? "") as { derived?: unknown; fresh?: unknown; pruned?: unknown };
        return typeof summary.derived === "number" && typeof summary.fresh === "number"
            ? ` (last sweep: ${summary.derived} derived, ${summary.fresh} already fresh${typeof summary.pruned === "number" && summary.pruned > 0 ? `, ${summary.pruned} pruned` : ""})`
            : "";
    } catch {
        // allow(silent-catch): a log that is not one finished JSON summary is a sweep still running or one that died, and neither has a result to quote.
        return "";
    }
};

const shadowLine = (args: StatsArgs): string => {
    if (!args.options.shadows) {
        return "Document shadows: switched off.";
    }
    if (args.project === undefined) {
        return "Document shadows: reported per project.";
    }
    const count = countShadows(join(args.project, DERIVED_DIR));
    return `Document shadows: ${count} documents have a markdown shadow${lastSweep(args.data, args.project)}. Nothing measures what they save yet.`;
};

// ---- the report ---------------------------------------------------------------------------------------------------

const inScope = (args: StatsArgs, project: string | undefined): boolean => args.project === undefined || project === args.project;

export const statsReport = (args: StatsArgs): string => {
    const rows: StatRow[] = parseStatsFile(readText(join(outputDir(args.data), "filter-stats.jsonl")) ?? "").filter((row) => inScope(args, row.project));
    const sessions = readSessions(args.data)
        .filter((row) => inScope(args, row.project))
        .toSorted((left, right) => right.ts - left.ts)
        .slice(0, MAX_SESSIONS);
    const turns = sessions.flatMap(turnsOf);
    const switches = (Object.keys(OPTIONS) as (keyof Options)[]).map((key) => `${key}=${String(args.options[key])}`).join(" ");
    return [
        `# intentic: what the plugin saved`,
        ``,
        `Scope: ${args.project === undefined ? "every project" : `\`${args.project}\``} · ${sessions.length} recorded sessions · switches as the last session opened: ${switches}`,
        ``,
        `## Bash output`,
        ...cleanerLines(summarizeStats(rows), args.options),
        ``,
        `## Session context`,
        ...DESIGNS.map(({ title, option, design, reads }) =>
            mechanismLine(title, reads, args.options[option] === true, measureExperiment(turns, design), args.options.holdout),
        ),
        ``,
        shadowLine(args),
        ``,
    ].join("\n");
};

// `--data <dir> --project <dir> [--option key=value]… [all]`; the skill passes the plugin's data directory and the
// project, and the person may add `all`. The switches are the ones the last session opened with (features.ts
// loadOptions); `--option` overrides one, for a report run by hand.
export const parseStatsArgs = (argv: readonly string[]): StatsArgs => {
    let data = "";
    let project: string | undefined;
    let all = false;
    const overrides: Record<string, string> = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? "";
        if (arg === "--data") {
            data = argv[(index += 1)] ?? "";
        } else if (arg === "--project") {
            project = argv[(index += 1)];
        } else if (arg === "--option") {
            const [key, ...value] = (argv[(index += 1)] ?? "").split("=");
            overrides[optionEnvName((key ?? "") as OptionKey)] = value.join("=");
        } else if (arg === "all") {
            all = true;
        }
    }
    const saved = loadOptions(data);
    const env = Object.fromEntries((Object.keys(OPTIONS) as OptionKey[]).map((key) => [optionEnvName(key), String(saved[key])]));
    return { data, project: all ? undefined : project, options: readOptions({ ...env, ...overrides }) };
};

if (process.argv[1]?.endsWith("stats.mjs")) {
    process.stdout.write(statsReport(parseStatsArgs(process.argv.slice(2))));
}
