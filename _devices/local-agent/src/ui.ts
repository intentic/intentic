// Wire contract for what a local agent shows: `plain` emits only the marker stream a pipe/CI parses, `rich` redraws for
// a terminal, `nested` folds into a parent's own checklist. The live line never wraps (width is unknown under curl|sh);
// anything else writing to stdout must be bracketed by suspend()/resume(). The shapes themselves are layout.ts, shared
// with ic's ui.rs; which shape a command draws is docs/ops/cli-output-protocol.md.

import {
    ASCII,
    CANCELLED,
    CYAN,
    DIM,
    fieldLines,
    footnoteLines,
    GREEN,
    headingLines,
    itemLines,
    liveLine,
    paint,
    planSummary,
    plainFieldLines,
    plainItemLines,
    plainRowLine,
    plainSectionLines,
    quietLine,
    RED,
    rowLines,
    sectionLines,
    settledLine,
    stopLines,
    UNICODE,
    verdictLines,
    wrap,
    YELLOW,
    type Footnote,
    type Item,
    type Pen,
    type Tone,
} from "./layout.js";

export { displayWidth, explain, truncate, wrap, type Footnote, type Item, type Tone } from "./layout.js";

/** How a run renders, chosen once from the environment (see createUi). */
export type UiMode = "rich" | "plain" | "nested";

/** One step of a flow: phase id, label, and a rough weight (seconds) used only to compare, for a time estimate rather than a step count. */
export interface PlanStep {
    readonly phase: string;
    readonly label: string;
    readonly weight: number;
}

/** A settled verdict about one thing; same vocabulary as ic's rows. */
export type RowOutcome = "pass" | "warn" | "fail" | "skip";

export interface Ui {
    readonly mode: UiMode;

    // Flow: several steps with a promise of scope and time.

    /** Banner plus one dim scope line (`scope`, or the plan's own size and time); no-op outside `rich`. */
    begin: (title: string, plan?: readonly PlanStep[], scope?: string) => void;
    /** One phase of the flow: a marker on the wire, a checklist row on screen. */
    step: (phase: string, message: string) => void;
    /** Replaces the running step's sub-detail; rich only, ignored in plain. */
    detail: (text: string) => void;
    /** A changing measurement (e.g. bytes downloaded); a pipe gets every reading, a screen only the newest. */
    progress: (text: string) => void;
    row: (outcome: RowOutcome, name: string, note?: string) => void;
    /** Narration under the running step; the `intentic: ` prefix is part of the plain contract, added here. */
    note: (text: string) => void;
    /** A caution, not a failure; goes to stderr in `plain`. */
    warn: (text: string) => void;
    /** End of a successful flow: one address, one instruction, then footnotes. */
    finished: (verdict: string, address: string | undefined, instruction: string, footnotes?: readonly Footnote[]) => void;

    // Action: one thing, one live line that settles in place.

    /** Starts the one live line, in the present tense ("Stopping sandbox-x"). */
    act: (label: string) => void;
    /** Settles it as a past-tense sentence ("Stopped sandbox-x."), with its time. */
    done: (verdict: string) => void;

    // Report: read-only, the same glyph column without timings.

    /** A report's header: title, version stamp, and an optional dim scope line. Nothing in `plain`. */
    report: (title: string, scope?: string) => void;
    items: (items: readonly Item[]) => void;
    section: (title: string) => void;
    /** Facts as key and value; `Key: value` lines in `plain`. */
    fields: (fields: readonly Footnote[]) => void;
    /** A neutral one-line outcome: an empty report, nothing to do. */
    quiet: (sentence: string) => void;
    /** The person said no: one line, nothing changed. */
    cancelled: () => void;
    /** The commands a reader will want later, after an action or a report. */
    later: (footnotes: readonly Footnote[]) => void;
    /** A line only a log reader gets; nothing on a screen. For plain sentences something downstream reads by name. */
    plain: (text: string) => void;

    // Stop.

    /** A stopped run: the running step settles as failed, then the stop block on stderr. Compose `message` with `explain`. */
    fail: (message: string) => void;

    /** Hands the terminal to a child process that writes its own output. */
    suspend: () => void;
    resume: () => void;
    /** Settles the running step and stops repainting; safe to call twice. */
    close: () => void;
}

// What the renderer needs from the outside.

/** Process seams this reads, matching what stricli injects as `this.process`; a command passes its context, a test passes a fake. */
export interface UiProcess {
    readonly stdout: { write: (chunk: string) => unknown; isTTY?: boolean | undefined; columns?: number | undefined };
    readonly stderr: { write: (chunk: string) => unknown };
    readonly env?: Record<string, string | undefined> | undefined;
}

/** What the caller knows that the environment does not. */
export interface UiOptions {
    /** Shown dim at the right of a header, e.g. `intentic-machine 1.4.0`. */
    readonly stamp?: string | undefined;
}

/** How often the spinner repaints: fast enough to read as motion, cheap enough to ignore. */
const TICK_MS = 110;
/** Below this, a countdown is more wrong than helpful on every repaint. */
const ESTIMATE_FLOOR_SECONDS = 20;

// Pure helpers, exported for their own tests.

/**
 * A duration as a person would say it: precise while that's interesting, rounded once it isn't. Counted in whole tenths
 * and minutes, half up, as ui.rs's human_duration counts them: floating point would round 150 ms one way here and the
 * other way there.
 */
export const humanDuration = (milliseconds: number): string => {
    const total = Math.max(0, Math.floor(milliseconds));
    const tenths = Math.floor((total + 50) / 100);
    if (tenths < 100) {
        return `${Math.floor(tenths / 10)}.${tenths % 10}s`;
    }
    // 9.95 s rounds up to ten, which is read in whole seconds.
    const seconds = Math.max(10, Math.floor(total / 1000));
    return seconds >= 90 ? `${Math.floor((seconds + 30) / 60)}m` : `${seconds}s`;
};

/** The narrowest line laid out: below it a budget would reach zero. The same floor and ceiling as ui.rs's width_from. */
const MIN_WIDTH = 20;
/** Past this a line is too long to read in one sweep, whatever the terminal could hold. */
const MAX_WIDTH = 120;

/**
 * The width to draw at: what the terminal reports, else `COLUMNS`, else 80; never inflated, so a real 30-column terminal
 * is drawn 30 wide and nothing wraps. The same rule as ui.rs's width_from.
 */
export const widthFrom = (reported: number | undefined, columns: string | undefined): number => {
    const named = columns?.trim() ?? "";
    const fallback = /^\d+$/u.test(named) && Number(named) > 0 ? Number(named) : 80;
    const width = reported !== undefined && Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : fallback;
    return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
};

/**
 * Whether the console can draw the Unicode glyphs, decided by the locale and the console as ui.rs decides it, never by
 * colour (NO_COLOR asks for no colour, not for ASCII). The first of LC_ALL, LC_CTYPE and LANG that is set and not empty
 * names the encoding, as POSIX reads them; none at all is not evidence of anything (sudo and `curl | sh` drop them). On
 * Windows ui.rs asks whether the console took virtual-terminal processing; Node's console stream handles those sequences
 * itself, so the answer here is always yes.
 */
export const unicodeSafe = (env: Record<string, string | undefined>, platform: string): boolean => {
    if (platform === "win32") {
        return true;
    }
    const locale = [env["LC_ALL"], env["LC_CTYPE"], env["LANG"]].find((value) => value !== undefined && value !== "");
    return locale === undefined || /utf-?8/iu.test(locale);
};

/**
 * Time left, from remaining plan weight and this run's pace so far; clamped, since a swinging estimate is worse than a
 * stable rough one. Undefined below the floor or without enough evidence yet.
 */
export const estimate = (totalWeight: number, consumed: number, elapsedSeconds: number): string | undefined => {
    if (totalWeight <= 0 || consumed < 1) {
        return undefined;
    }
    const pace = Math.min(3, Math.max(0.5, elapsedSeconds / consumed));
    const left = Math.max(0, (totalWeight - consumed) * pace);
    return left < ESTIMATE_FLOOR_SECONDS ? undefined : humanDuration(left * 1000);
};

/** Sentence-cases a step's own prose, for phases the plan doesn't label. */
export const asLabel = (message: string): string => {
    const trimmed = message.replace(/[…. ]+$/u, "");
    return trimmed === "" ? "" : trimmed[0]!.toUpperCase() + trimmed.slice(1);
};

/** A label as plain narration: lower-cased unless its first word is an acronym or a name ("ic", "Docker" stay). */
// The same names as ui.rs's as_narration, so the two tools narrate a shared step identically.
const NAMES = new Set(["Docker", "Intentic", "WSL", "Windows"]);
const asNarration = (label: string): string => {
    const first = label.split(" ")[0] ?? "";
    const isWord = [...first].length > 1 && first.slice(1) === first.slice(1).toLowerCase() && !NAMES.has(first);
    return isWord ? first[0]!.toLowerCase() + label.slice(1) : label;
};

const toneOf = (outcome: RowOutcome): Tone => (outcome === "pass" ? "ok" : outcome);

// The renderer.

/**
 * INTENTIC_UI forces a mode outright (`ic` sets `nested` when it spawns one of these mid-install); otherwise isTTY
 * decides rich vs plain, so a pipe never reaches the redrawing path.
 */
const detectMode = (process: UiProcess): UiMode => {
    const forced = process.env?.["INTENTIC_UI"];
    if (forced === "plain" || forced === "rich" || forced === "nested") {
        return forced;
    }
    // Historical escape hatch ic also honours, kept spelled the same.
    if (process.env?.["INTENTIC_PLAIN"] === "1") {
        return "plain";
    }
    return process.stdout.isTTY === true ? "rich" : "plain";
};

export const createUi = (process: UiProcess, options: UiOptions = {}): Ui => {
    const mode = detectMode(process);
    const env = process.env ?? {};
    const colour = mode !== "plain" && (env["FORCE_COLOR"] !== undefined || env["NO_COLOR"] === undefined);
    const width = widthFrom(process.stdout.columns, env["COLUMNS"]);
    const pen: Pen = { colour, glyphs: unicodeSafe(env, globalThis.process.platform) ? UNICODE : ASCII, width };

    const out = (text: string): void => void process.stdout.write(text);
    const lines = (all: readonly string[]): void => {
        for (const line of all) {
            out(`${line}\n`);
        }
    };

    let plan: readonly PlanStep[] = [];
    let index: number | undefined;
    let ordinal = 0;
    /** Whether the live line is a flow's numbered step or an action's single line. */
    let numbered = true;
    let label = "";
    let detailText = "";
    let started = Date.now();
    let stepStarted = Date.now();
    let frame = 0;
    let live = false;
    let suspended = false;
    let behind = 0;
    let ticker: ReturnType<typeof setInterval> | undefined;

    const totalWeight = (): number => plan.reduce((sum, step) => sum + step.weight, 0);

    /**
     * Progress through the running step, 0..1, capped short of 1 since only the flow knows when a step is truly done.
     */
    const stepFraction = (): number => {
        if (index === undefined) {
            return 0;
        }
        const weight = plan[index]?.weight ?? 0;
        return weight <= 0 ? 0 : Math.min(0.9, (Date.now() - stepStarted) / 1000 / weight);
    };

    const remaining = (): string | undefined => {
        if (index === undefined) {
            return undefined;
        }
        return estimate(totalWeight(), behind + (plan[index]?.weight ?? 0) * stepFraction(), (Date.now() - started) / 1000);
    };

    const erase = (): void => {
        if (!live) {
            return;
        }
        // Spaces, not an erase-to-end escape: this must work on a console with no virtual-terminal processing. One short
        // of the width, as the live line is: a console that wraps on reaching the last column would push this a row down.
        out(`\r${" ".repeat(width - 1)}\r`);
        live = false;
    };

    const repaint = (): void => {
        if (mode !== "rich" || suspended || label === "") {
            return;
        }
        const spinner = pen.glyphs.spinner[frame % pen.glyphs.spinner.length] ?? "";
        const elapsed = humanDuration(Date.now() - stepStarted);
        const left = remaining();
        const right = left === undefined || Date.now() - stepStarted < 5000 ? elapsed : `${elapsed} · ~${left} left`;
        out(`\r${liveLine(pen, spinner, numbered ? ordinal : undefined, label, detailText, right)}`);
        live = true;
    };

    /** Prints above the live line: erase, write, redraw. */
    const above = (text: string): void => {
        erase();
        out(`${text}\n`);
        repaint();
    };

    /** Repaints on a timer so a wait isn't mistaken for a hang; unref'd so a spinner never blocks exit. */
    const startTicker = (): void => {
        if (mode !== "rich" || ticker !== undefined) {
            return;
        }
        ticker = setInterval(() => {
            frame += 1;
            repaint();
        }, TICK_MS);
        ticker.unref();
    };

    const stopTicker = (): void => {
        if (ticker !== undefined) {
            clearInterval(ticker);
            ticker = undefined;
        }
    };

    /**
     * Turns the running step into a settled line with its duration, so a slow step and a fast one still read
     * differently afterward. A failed step settles as failed, so the reader sees where the run stopped.
     */
    const settle = (tone: Tone = "ok", as?: string): void => {
        if (label === "") {
            return;
        }
        erase();
        if (index !== undefined) {
            behind += plan[index]?.weight ?? 0;
        }
        out(`${settledLine(pen, tone, numbered ? ordinal : undefined, as ?? label, humanDuration(Date.now() - stepStarted))}\n`);
        label = "";
        detailText = "";
    };

    /** Indented dim narration: how everything reads in `nested`, and how detail reads in `rich`. */
    const nestedLine = (text: string, marker?: string): void => {
        for (const [at, part] of wrap(text, width - 10).entries()) {
            const lead = at === 0 && marker !== undefined ? `     ${marker}  ` : "        ";
            above(`${lead}${paint(pen, part, DIM)}`);
        }
    };

    const nestedMarker = (tone: Tone): string => (tone === "ok" ? pen.glyphs.ok : tone === "fail" ? pen.glyphs.fail : tone === "warn" ? pen.glyphs.warn : pen.glyphs.skip);

    return {
        mode,

        begin: (title, steps = [], scope) => {
            plan = steps;
            started = Date.now();
            if (mode !== "rich") {
                return;
            }
            const promise = scope ?? (steps.length > 0 ? planSummary(steps.length, steps.reduce((sum, step) => sum + step.weight, 0)) : undefined);
            lines(headingLines(pen, title, options.stamp, promise));
            startTicker();
        },

        step: (phase, message) => {
            if (mode === "plain") {
                out(`intentic: [${phase}] ${message}\n`);
                return;
            }
            if (mode === "nested") {
                // Inside a parent's checklist, a step is detail under theirs, not a step of its own.
                nestedLine(asLabel(message));
                return;
            }
            settle();
            const found = plan.findIndex((planned) => planned.phase === phase);
            // Cursor only moves forward: a phase already passed is narration, not a step.
            const at = found >= 0 && (index === undefined || found >= index) ? found : undefined;
            index = at;
            numbered = true;
            label = at === undefined ? asLabel(message) : (plan[at]?.label ?? asLabel(message));
            detailText = "";
            ordinal += 1;
            stepStarted = Date.now();
            frame = 0;
            startTicker();
            repaint();
        },

        detail: (text) => {
            if (mode !== "rich" || detailText === text) {
                return;
            }
            detailText = text;
            repaint();
        },

        progress: (text) => {
            if (mode === "plain") {
                out(`      ${text}\n`);
                return;
            }
            if (mode === "nested") {
                nestedLine(text);
                return;
            }
            detailText = text;
            repaint();
        },

        row: (outcome, name, note = "") => {
            if (mode === "plain") {
                out(`${plainRowLine(toneOf(outcome), name, note)}\n`);
                return;
            }
            for (const line of rowLines(pen, toneOf(outcome), name, note)) {
                above(line);
            }
        },

        note: (text) => {
            if (mode === "plain") {
                out(`intentic: ${text}\n`);
                return;
            }
            for (const part of wrap(text, width - 8)) {
                above(`        ${paint(pen, part, DIM)}`);
            }
        },

        warn: (text) => {
            if (mode === "plain") {
                for (const [at, part] of text.split("\n").entries()) {
                    process.stderr.write(at === 0 ? `intentic: ${part}\n` : `          ${part}\n`);
                }
                return;
            }
            let first = true;
            for (const paragraph of text.split("\n")) {
                for (const part of wrap(paragraph, width - 9)) {
                    above(first ? `     ${paint(pen, pen.glyphs.warn, YELLOW)}  ${paint(pen, part, DIM)}` : `        ${paint(pen, part, DIM)}`);
                    first = false;
                }
            }
        },

        finished: (verdict, address, instruction, footnotes = []) => {
            if (mode === "plain") {
                out(`${verdict}\n`);
                if (address !== undefined) {
                    out(`${address}\n`);
                }
                if (instruction !== "") {
                    out(`${instruction}\n`);
                }
                for (const [what, command] of footnotes) {
                    out(`${what}: ${command}\n`);
                }
                return;
            }
            if (mode === "nested") {
                // The parent owns the ending; this only carries up the one fact worth keeping.
                nestedLine(verdict, paint(pen, pen.glyphs.ok, GREEN));
                if (address !== undefined) {
                    nestedLine(address);
                }
                return;
            }
            settle();
            stopTicker();
            lines(verdictLines(pen, "ok", verdict, `took ${humanDuration(Date.now() - started)}`));
            if (address !== undefined) {
                out(`\n     ${paint(pen, address, CYAN)}\n`);
            }
            if (instruction !== "") {
                out("\n");
                lines(wrap(instruction, width - 6).map((part) => `     ${part}`));
            }
            if (footnotes.length > 0) {
                out("\n");
                lines(footnoteLines(pen, footnotes));
            }
            out("\n");
        },

        act: (text) => {
            if (mode === "plain") {
                out(`intentic: ${asNarration(text)}…\n`);
                return;
            }
            if (mode === "nested") {
                nestedLine(text);
                return;
            }
            settle();
            index = undefined;
            numbered = false;
            label = text;
            detailText = "";
            stepStarted = Date.now();
            frame = 0;
            startTicker();
            repaint();
        },

        done: (verdict) => {
            if (mode === "plain") {
                out(`intentic: ${verdict}\n`);
                return;
            }
            if (mode === "nested") {
                nestedLine(verdict, paint(pen, pen.glyphs.ok, GREEN));
                return;
            }
            if (label === "") {
                out(`${settledLine(pen, "ok", undefined, verdict, "")}\n`);
                return;
            }
            settle("ok", verdict);
        },

        report: (title, scope) => {
            if (mode !== "rich") {
                return;
            }
            settle();
            lines(headingLines(pen, title, options.stamp, scope));
        },

        items: (items) => {
            if (mode === "plain") {
                lines(plainItemLines(items));
                return;
            }
            if (mode === "nested") {
                for (const item of items) {
                    nestedLine(item.meta === undefined || item.meta === "" ? item.name : `${item.name} — ${item.meta}`, nestedMarker(item.tone));
                }
                return;
            }
            for (const line of itemLines(pen, items)) {
                above(line);
            }
        },

        section: (title) => {
            if (mode === "plain") {
                lines(plainSectionLines(title));
                return;
            }
            if (mode === "nested") {
                nestedLine(title);
                return;
            }
            for (const line of sectionLines(pen, title)) {
                above(line);
            }
        },

        fields: (fields) => {
            if (mode === "plain") {
                lines(plainFieldLines(fields));
                return;
            }
            if (mode === "nested") {
                for (const [key, value] of fields) {
                    nestedLine(`${key}: ${value}`);
                }
                return;
            }
            for (const line of fieldLines(pen, fields)) {
                above(line);
            }
        },

        quiet: (sentence) => {
            if (mode === "plain") {
                out(`intentic: ${sentence}\n`);
                return;
            }
            if (mode === "nested") {
                nestedLine(sentence);
                return;
            }
            above(quietLine(pen, sentence));
        },

        cancelled: () => {
            if (mode === "plain") {
                out(`intentic: ${CANCELLED}\n`);
                return;
            }
            settle("skip");
            if (mode === "nested") {
                nestedLine(CANCELLED);
                return;
            }
            out(`${quietLine(pen, CANCELLED)}\n`);
        },

        later: (footnotes) => {
            if (mode !== "rich" || footnotes.length === 0) {
                return;
            }
            settle();
            lines(footnoteLines(pen, footnotes));
        },

        plain: (text) => {
            if (mode === "plain") {
                out(`${text}\n`);
            }
        },

        fail: (message) => {
            if (mode === "plain") {
                process.stderr.write(`error: ${message}\n`);
                return;
            }
            if (mode === "nested") {
                // Folded under the parent's step, but whole: the headline alone would leave the person with no why and
                // nothing to do, since the parent only reports that this child failed.
                erase();
                const [headline = "", ...rest] = message.split("\n");
                for (const [at, part] of wrap(headline, width - 10).entries()) {
                    process.stderr.write(`${at === 0 ? `     ${paint(pen, pen.glyphs.fail, RED)}  ` : "        "}${paint(pen, part, RED)}\n`);
                }
                for (const raw of rest) {
                    const body = raw.trim();
                    const split = body.indexOf(": ");
                    const label = split > 0 ? body.slice(0, split) : "";
                    if (label === "problem" || label === "fix") {
                        const padded = `${label}:`.padEnd(9);
                        for (const [at, part] of wrap(body.slice(split + 2), width - 9 - padded.length).entries()) {
                            process.stderr.write(`${at === 0 ? `        ${paint(pen, padded, DIM)}` : " ".repeat(8 + padded.length)}${part}\n`);
                        }
                    } else if (body !== "") {
                        for (const part of wrap(body, width - 9)) {
                            process.stderr.write(`        ${part}\n`);
                        }
                    }
                }
                return;
            }
            settle("fail");
            stopTicker();
            for (const line of stopLines(pen, message)) {
                process.stderr.write(`${line}\n`);
            }
        },

        suspend: () => {
            if (mode !== "rich") {
                return;
            }
            erase();
            suspended = true;
        },

        resume: () => {
            if (mode !== "rich") {
                return;
            }
            suspended = false;
            repaint();
        },

        close: () => {
            if (mode === "rich") {
                settle();
            }
            stopTicker();
        },
    };
};
