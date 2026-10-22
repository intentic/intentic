import type { ViewBadge } from "@intentic/extension-api";
import type { IconName, Tone } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { parseJsonWith, type SafeParser } from "@intentic/base/json";
import { z } from "zod";
import type { LocalRepairMessage, LocalRepairSession, LocalRepairTool } from "../../app/environments/localHost";

/* WHAT REPAIR'S TOOLS SAID, READ FOR THE PAGE. The app hands each tool call's output over as the text `ic` printed
   (repair/mod.rs `set_tool_row`): `ic sandbox doctor --json` as one report per sandbox, `ic engine status --json` as one
   document. Until 2026-10-22 the page showed that text raw behind "Details"; it is read here into checks and facts the
   page draws, and the raw text stays one press away (per tool, and the whole session as a log). Anything that does not
   read as one of these keeps its text: a parse that fails is a plain card, never a lost one. */


/** One check of `ic sandbox doctor`, as its report carries it (ic: sandbox/fix/model.rs `wire`). */
export interface DoctorCheck {
    readonly id: string;
    readonly label: string;
    readonly state: CheckState;
    /** On a warn or a fail: what is wrong, in the reader's terms. */
    readonly problem?: string | undefined;
    /** On a warn or a fail: what closes it. */
    readonly remedy?: string | undefined;
    /** Who can close it: ic by itself, ic once someone says yes, or only a person. */
    readonly fix?: `auto` | `consent` | `you` | undefined;
}

export interface DoctorReport {
    /** The sandbox it is about; empty for a report that names none. */
    readonly slug: string;
    /** `healthy`, `fixed`, `needs-you`, `failed`: how the run ended. */
    readonly outcome?: string | undefined;
    readonly asleep: boolean;
    readonly checks: readonly DoctorCheck[];
}

/** `ic engine status --json`: the engine sandboxes run on, and Intentic's own engine's state (ic: engine/commands.rs). */
export interface EngineReport {
    /** `intentic`, `dockerDesktop`, `native`. */
    readonly engine: string;
    readonly installed: boolean;
    readonly running: boolean;
    /** Stopped on purpose: nothing restarts it until someone starts it. */
    readonly held: boolean;
    readonly version?: string | undefined;
}

const CHECK_STATES = [`ok`, `warn`, `fail`, `fixing`, `skip`] as const;
export type CheckState = (typeof CHECK_STATES)[number];

// One check as the report carries it; a check this page cannot read is dropped from its report, never the report.
const CheckSchema = z.object({
    id: z.string(),
    label: z.string().optional(),
    state: z.enum(CHECK_STATES),
    problem: z.string().optional(),
    remedy: z.string().optional(),
    fix: z.enum([`auto`, `consent`, `you`]).optional().catch(undefined),
});

const ReportSchema = z.object({
    slug: z.string().optional(),
    outcome: z.string().optional(),
    asleep: z.boolean().optional(),
    checks: z.array(CheckSchema.optional().catch(undefined)),
});
type RawReport = z.infer<typeof ReportSchema>;

// A sandbox's report as `ic` prints it (`{ slug, report }`, report.rs `result_line`), or a report on its own.
const EntrySchema = z.union([z.object({ slug: z.string().optional(), report: ReportSchema }), ReportSchema]);
const DoctorDocumentSchema = z.union([z.array(EntrySchema.optional().catch(undefined)), EntrySchema]);
type DoctorEntry = z.infer<typeof EntrySchema>;

const EngineSchema = z.object({
    engine: z.string(),
    installed: z.boolean().catch(false),
    running: z.boolean().catch(false),
    held: z.boolean().catch(false),
    version: z.string().nullish(),
});

// What a schema reads out of a transcript: the whole of it when it is one document, else every line that is one. A
// progress line (`intentic-fix: {...}`) does not start with a brace, so it is passed over.
const documentsOf = <T>(raw: string, schema: SafeParser<T>): T[] => {
    const whole = parseJsonWith(raw.trim(), schema);
    if (whole !== undefined) {
        return [whole];
    }
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`{`) || line.startsWith(`[`))
        .map((line) => parseJsonWith(line, schema))
        .filter((value) => value !== undefined);
};

const reportOf = (slug: string | undefined, raw: RawReport): DoctorReport => ({
    slug: slug ?? raw.slug ?? ``,
    outcome: raw.outcome,
    asleep: raw.asleep === true,
    checks: raw.checks
        .filter((check) => check !== undefined)
        .map((check) => ({ id: check.id, label: check.label ?? check.id, state: check.state, problem: check.problem, remedy: check.remedy, fix: check.fix })),
});

const entryReport = (entry: DoctorEntry): DoctorReport => (`report` in entry ? reportOf(entry.slug, entry.report) : reportOf(undefined, entry));

/** Every sandbox's report in what `ic sandbox doctor --json` printed, one per sandbox (the last word on each); none read. */
export const doctorReports = (raw: string): readonly DoctorReport[] | undefined => {
    const bySlug = new Map<string, DoctorReport>();
    for (const document of documentsOf(raw, DoctorDocumentSchema)) {
        const entries = Array.isArray(document) ? document.filter((entry) => entry !== undefined) : [document];
        for (const report of entries.map(entryReport)) {
            bySlug.set(report.slug, report);
        }
    }
    return bySlug.size === 0 ? undefined : [...bySlug.values()];
};

/** What `ic engine status --json` printed, read; undefined for anything else. */
export const engineReport = (raw: string): EngineReport | undefined => {
    const found = documentsOf(raw, EngineSchema)[0];
    return found === undefined
        ? undefined
        : { engine: found.engine, installed: found.installed, running: found.running, held: found.held, version: found.version ?? undefined };
};

/** What a tool's output reads as: a doctor's reports, the engine's state, or only its text. */
export type ToolReading =
    | { readonly kind: `doctor`; readonly reports: readonly DoctorReport[] }
    | { readonly kind: `engine`; readonly engine: EngineReport }
    | { readonly kind: `text`; readonly text: string }
    | { readonly kind: `none` };

/** A text short enough to stand as a sentence on the card rather than behind the raw-output press. */
const SHORT_TEXT = 240;

export const readTool = (tool: LocalRepairTool): ToolReading => {
    const detail = tool.detail?.trim() ?? ``;
    if (detail === ``) {
        return { kind: `none` };
    }
    if (tool.name === `doctor`) {
        const reports = doctorReports(detail);
        if (reports !== undefined) {
            return { kind: `doctor`, reports };
        }
    }
    if (tool.name === `engine_status`) {
        const engine = engineReport(detail);
        if (engine !== undefined) {
            return { kind: `engine`, engine };
        }
    }
    return detail.length <= SHORT_TEXT && !detail.includes(`\n`) && !detail.startsWith(`{`) && !detail.startsWith(`[`)
        ? { kind: `text`, text: detail }
        : { kind: `none` };
};

/** The worst a doctor's checks say, as a tone: a fail is danger, a warn a warning, all fine success. */
const reportTone = (reports: readonly DoctorReport[]): Tone => {
    const states = new Set(reports.flatMap((report) => report.checks.map((check) => check.state)));
    if (states.has(`fail`)) {
        return `danger`;
    }
    if (states.has(`warn`) || states.has(`fixing`)) {
        return `warning`;
    }
    return `success`;
};

export const engineTone = (engine: EngineReport): Tone => {
    if (engine.engine !== `intentic`) {
        return `success`;
    }
    if (!engine.installed || !engine.running) {
        return engine.held ? `warning` : `danger`;
    }
    return `success`;
};

/** How a row or a card wears where it stands: its tone and its glyph. */
export interface Look {
    readonly tone: Tone;
    readonly icon: IconName;
}

/** A tool card's tone and glyph: where it stands, and once it is done, what it found. */
export const toolLook = (tool: LocalRepairTool): Look => {
    switch (tool.state) {
        case `running`:
            return { tone: `info`, icon: `spinner` };
        case `needsApproval`:
            return { tone: `warning`, icon: `shield` };
        case `refused`:
            return { tone: `neutral`, icon: `times` };
        case `failed`:
            return { tone: `danger`, icon: `exclamation-circle` };
        case `done`: {
            const reading = readTool(tool);
            const tone = reading.kind === `doctor` ? reportTone(reading.reports) : reading.kind === `engine` ? engineTone(reading.engine) : `success`;
            return { tone, icon: tone === `success` ? `check-circle` : `exclamation-circle` };
        }
    }
};

export const checkLook = (state: CheckState): Look => {
    switch (state) {
        case `ok`:
            return { tone: `success`, icon: `check-circle` };
        case `warn`:
            return { tone: `warning`, icon: `exclamation-circle` };
        case `fail`:
            return { tone: `danger`, icon: `exclamation-circle` };
        case `fixing`:
            return { tone: `info`, icon: `spinner` };
        case `skip`:
            return { tone: `neutral`, icon: `circle` };
    }
};

const tools = (session: LocalRepairSession): LocalRepairTool[] =>
    session.messages.map((message) => message.tool).filter((tool): tool is LocalRepairTool => tool !== undefined);

/** Repair is doing something now: thinking, or a tool of its running. */
export const repairWorking = (session: LocalRepairSession): boolean =>
    session.state === `thinking` || tools(session).some((tool) => tool.state === `running`);

/** Changes waiting for the reader's Allow. */
const pendingApprovals = (session: LocalRepairSession): number =>
    tools(session).filter((tool) => tool.state === `needsApproval` && tool.approvalId !== undefined).length;

/** THE PAGE'S HEADLINE: one sentence over the whole session, so the reader need not add the cards up. */
export interface RepairVerdict {
    readonly tone: Tone;
    readonly icon: IconName;
    readonly title: string;
    readonly detail?: string;
    readonly busy: boolean;
}

// The latest doctor's findings that are not fine, across every sandbox it looked at.
interface Findings {
    readonly fails: number;
    readonly warns: number;
    /** A doctor's report was read at all: none read is not "all fine". */
    readonly read: boolean;
}

const latestFindings = (session: LocalRepairSession): Findings => {
    const doctor = tools(session)
        .filter((tool) => tool.name === `doctor` && tool.state === `done`)
        .map(readTool)
        .findLast((reading) => reading.kind === `doctor`);
    if (doctor?.kind !== `doctor`) {
        return { fails: 0, warns: 0, read: false };
    }
    const states = doctor.reports.flatMap((report) => report.checks.map((check) => check.state));
    return { fails: states.filter((state) => state === `fail`).length, warns: states.filter((state) => state === `warn`).length, read: true };
};

export const repairVerdict = (session: LocalRepairSession): RepairVerdict => {
    const asking = pendingApprovals(session);
    if (asking > 0) {
        return { tone: `warning`, icon: `shield`, title: t(`local.repair.verdict.asking`, { count: asking }, asking), detail: t(`local.repair.verdict.askingDetail`), busy: false };
    }
    if (repairWorking(session)) {
        const running = tools(session).findLast((tool) => tool.state === `running`);
        return { tone: `info`, icon: `spinner`, title: running?.summary ?? t(`local.repair.verdict.thinking`), detail: t(`local.repair.verdict.workingDetail`), busy: true };
    }
    if (session.messages.length === 0) {
        return { tone: `neutral`, icon: `wrench`, title: t(`local.repair.verdict.empty`), detail: t(`local.repair.verdict.emptyDetail`), busy: false };
    }
    const findings = latestFindings(session);
    const failedTools = tools(session).filter((tool) => tool.state === `failed`).length;
    if (findings.fails > 0) {
        return { tone: `danger`, icon: `exclamation-circle`, title: t(`local.repair.verdict.problems`, { count: findings.fails }, findings.fails), detail: t(`local.repair.verdict.problemsDetail`), busy: false };
    }
    if (failedTools > 0) {
        return { tone: `danger`, icon: `exclamation-circle`, title: t(`local.repair.verdict.checkFailed`, { count: failedTools }, failedTools), detail: t(`local.repair.verdict.problemsDetail`), busy: false };
    }
    if (findings.warns > 0) {
        return { tone: `warning`, icon: `exclamation-circle`, title: t(`local.repair.verdict.warnings`, { count: findings.warns }, findings.warns), busy: false };
    }
    if (findings.read) {
        return { tone: `success`, icon: `check-circle`, title: t(`local.repair.verdict.healthy`), detail: t(`local.repair.verdict.healthyDetail`), busy: false };
    }
    return { tone: `neutral`, icon: `wrench`, title: t(`local.repair.verdict.idle`), busy: false };
};

/** The rail tile's corner: the spinning mark while Repair works, a warning while it waits for an Allow. */
export const repairBadgeOf = (session: LocalRepairSession): ViewBadge | undefined => {
    const asking = pendingApprovals(session);
    if (asking > 0) {
        return { mark: `exclamation-circle`, tone: `warning`, tooltip: t(`local.repair.verdict.asking`, { count: asking }, asking) };
    }
    if (repairWorking(session)) {
        return { running: t(`local.repair.tileWorking`) };
    }
    return undefined;
};

/** Repair keeps its tile off the reader's page while it works or waits on them, so they can go and come back. */
export const repairHoldsRail = (session: LocalRepairSession): boolean => repairBadgeOf(session) !== undefined;

const STATE_WORD = {
    running: `running`,
    done: `done`,
    failed: `failed`,
    needsApproval: `waiting for your OK`,
    refused: `refused`,
} as const satisfies Record<LocalRepairTool[`state`], string>;

/** The whole session as plain text, for the raw log and its Copy: what was said, and every tool's output as it came. */
export const rawLog = (session: LocalRepairSession): string =>
    session.messages
        .map((message: LocalRepairMessage) => {
            if (message.tool !== undefined) {
                const head = `[${message.tool.name} · ${STATE_WORD[message.tool.state]}] ${message.tool.summary}`;
                return message.tool.detail === undefined || message.tool.detail.trim() === `` ? head : `${head}\n${message.tool.detail.trim()}`;
            }
            return message.role === `user` ? `> ${message.text}` : message.text;
        })
        .join(`\n\n`);
