// Wire contract for what a local agent shows: `plain` emits only the marker stream a pipe/CI parses, `rich` redraws for
// a terminal, `nested` folds into a parent's own checklist. The live line never wraps (width is unknown under curl|sh);
// anything else writing to stdout must be bracketed by suspend()/resume().

/** How a run renders, chosen once from the environment (see createUi). */
export type UiMode = "rich" | "plain" | "nested";

/**
 * One step of a flow: phase id, label, and a rough weight (seconds) used only to compare, for a time estimate rather
 * than a step count.
 */
export interface PlanStep {
    readonly phase: string;
    readonly label: string;
    readonly weight: number;
}

/** A settled verdict about one thing; same vocabulary as ic's rows. */
export type RowOutcome = "pass" | "warn" | "fail" | "skip";

/** A footnote on a finished run: what it does, and the command that does it. */
export type Footnote = readonly [what: string, command: string];

export interface Ui {
    readonly mode: UiMode;
    /** Banner plus the scope/time promise; no-op outside `rich`. */
    begin: (title: string, plan?: readonly PlanStep[]) => void;
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
    /** End of a successful run: one address, one instruction, then footnotes. */
    finished: (verdict: string, address: string | undefined, instruction: string, footnotes?: readonly Footnote[]) => void;
    /** Frame around a stopped run; the caller supplies the words, this only marks it as stopped. */
    fail: (message: string) => void;
    /** Hands the terminal to a child process that writes its own output. */
    suspend: () => void;
    resume: () => void;
    /** Settles the running step and stops repainting; safe to call twice. */
    close: () => void;
}

// What the renderer needs from the outside.

/**
 * Process seams this reads, matching what stricli injects as `this.process`; a command passes its context, a test
 * passes a fake.
 */
export interface UiProcess {
    readonly stdout: { write: (chunk: string) => unknown; isTTY?: boolean | undefined; columns?: number | undefined };
    readonly stderr: { write: (chunk: string) => unknown };
    readonly env?: Record<string, string | undefined> | undefined;
}

interface Glyphs {
    readonly ok: string;
    readonly fail: string;
    readonly warn: string;
    readonly skip: string;
    readonly spinner: readonly string[];
}

const UNICODE: Glyphs = { ok: "✓", fail: "✗", warn: "!", skip: "·", spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] };
// Windows consoles without virtual-terminal processing print the Unicode set as mojibake.
const ASCII: Glyphs = { ok: "+", fail: "x", warn: "!", skip: "-", spinner: ["|", "/", "-", "\\"] };

// \u001b escapes, never a literal control byte, or git/grep/diff treat the file as binary.
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

/** How often the spinner repaints: fast enough to read as motion, cheap enough to ignore. */
const TICK_MS = 110;
/** Below this, a countdown is more wrong than helpful on every repaint. */
const ESTIMATE_FLOOR_SECONDS = 20;

// Pure helpers, exported for their own tests.

/**
 * Wraps text to at most `width`; only the live line truncates instead. A word longer than width is left to overflow
 * rather than broken (a URL, meant to be copied).
 */
export const wrap = (text: string, width: number): string[] => {
    if (width < 20) {
        return [text];
    }
    const lines: string[] = [];
    let current = "";
    for (const word of text.split(/\s+/u).filter((part) => part !== "")) {
        if (current === "") {
            current = word;
        } else if ([...current].length + 1 + [...word].length <= width) {
            current = `${current} ${word}`;
        } else {
            lines.push(current);
            current = word;
        }
    }
    if (current !== "") {
        lines.push(current);
    }
    return lines.length === 0 ? [""] : lines;
};

/** Clips to `limit`, marking the cut; used only on the repainted line, which must not wrap. */
export const truncate = (text: string, limit: number): string => {
    const characters = [...text];
    if (characters.length <= limit) {
        return text;
    }
    if (limit <= 1) {
        return "";
    }
    return `${characters.slice(0, limit - 1).join("")}…`;
};

/** A duration as a person would say it: precise while that's interesting, rounded once it isn't. */
export const humanDuration = (milliseconds: number): string => {
    const seconds = Math.floor(Math.max(0, milliseconds) / 1000);
    if (seconds >= 90) {
        return `${Math.round(seconds / 60)}m`;
    }
    if (seconds >= 10) {
        return `${seconds}s`;
    }
    return `${(Math.max(0, milliseconds) / 1000).toFixed(1)}s`;
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

export const createUi = (process: UiProcess): Ui => {
    const mode = detectMode(process);
    const env = process.env ?? {};
    const colour = mode !== "plain" && (env["FORCE_COLOR"] !== undefined || env["NO_COLOR"] === undefined);
    // A reported width is trusted (80 is the floor); too low shortens a line, too high corrupts the repaint.
    const width = Math.min(120, Math.max(40, process.stdout.columns ?? 80));
    const glyphs = colour ? UNICODE : ASCII;

    const paint = (text: string, code: string): string => (colour ? `${code}${text}${RESET}` : text);
    const out = (text: string): void => void process.stdout.write(text);

    let plan: readonly PlanStep[] = [];
    let index: number | undefined;
    let ordinal = 0;
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
        // Spaces, not an erase-to-end escape: this must work on a console with no virtual-terminal processing.
        out(`\r${" ".repeat(width)}\r`);
        live = false;
    };

    const repaint = (): void => {
        if (mode !== "rich" || suspended || label === "") {
            return;
        }
        const spinner = glyphs.spinner[frame % glyphs.spinner.length] ?? "";
        const elapsed = humanDuration(Date.now() - stepStarted);
        const left = remaining();
        const right = left === undefined || Date.now() - stepStarted < 5000 ? elapsed : `${elapsed} · ~${left} left`;
        const head = `  ${spinner}  ${String(ordinal).padStart(2)}  ${label}`;
        // The line must never reach the last column, or the terminal wraps it and the next carriage return lands wrong.
        const budget = width - 1;
        const fixed = [...head].length + [...right].length + 1;
        const middle = detailText === "" ? "" : truncate(`  ·  ${detailText}`, Math.max(0, budget - fixed));
        const pad = " ".repeat(Math.max(0, budget - fixed - [...middle].length));
        const text = colour
            ? `  ${paint(spinner, CYAN)}  ${paint(String(ordinal).padStart(2), DIM)}  ${label}${middle === "" ? "" : paint(middle, DIM)}${pad} ${paint(right, DIM)}`
            : `${head}${middle}${pad} ${right}`;
        out(`\r${text}`);
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
        ticker.unref?.();
    };

    /**
     * Turns the running step into a settled line with its duration, so a slow step and a fast one still read
     * differently afterward.
     */
    const settle = (): void => {
        if (label === "") {
            return;
        }
        erase();
        if (index !== undefined) {
            behind += plan[index]?.weight ?? 0;
        }
        const took = humanDuration(Date.now() - stepStarted);
        // Padding is measured unpainted: colour escapes are zero-width but would miscount toward the margin.
        const bare = `  x  ${String(ordinal).padStart(2)}  ${label}`;
        const pad = " ".repeat(Math.max(0, width - 1 - [...bare].length - [...took].length));
        out(`  ${paint(glyphs.ok, GREEN)}  ${paint(String(ordinal).padStart(2), DIM)}  ${label}${pad}${paint(took, DIM)}\n`);
        label = "";
        detailText = "";
    };

    /** Indented dim narration: how everything reads in `nested`, and how detail reads in `rich`. */
    const nestedLine = (text: string, marker?: string): void => {
        for (const [at, part] of wrap(text, width - 10).entries()) {
            const lead = at === 0 && marker !== undefined ? `     ${marker}  ` : "        ";
            above(`${lead}${paint(part, DIM)}`);
        }
    };

    return {
        mode,

        begin: (title, steps = []) => {
            plan = steps;
            started = Date.now();
            if (mode !== "rich") {
                return;
            }
            out("\n");
            out(`  ${paint(title, BOLD)}\n`);
            if (steps.length > 0) {
                const seconds = steps.reduce((sum, step) => sum + step.weight, 0);
                const minutes = Math.max(1, Math.round(seconds / 60));
                out(`${paint(`  ${steps.length} steps, roughly ${minutes} minute${minutes === 1 ? "" : "s"}.`, DIM)}\n`);
            }
            out("\n");
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
                // The separator appears only when there is something after it.
                const tail = note === "" ? "" : `, ${note}`;
                const word = outcome === "pass" ? "ok  " : outcome === "fail" ? "FAIL" : outcome === "warn" ? "warn" : "skip";
                out(`  ${word}  ${name}${tail}\n`);
                return;
            }
            const glyph = outcome === "pass" ? glyphs.ok : outcome === "fail" ? glyphs.fail : outcome === "warn" ? glyphs.warn : glyphs.skip;
            const code = outcome === "pass" ? GREEN : outcome === "fail" ? RED : outcome === "warn" ? YELLOW : DIM;
            const body = note === "" ? name : `${name}, ${note}`;
            for (const [at, part] of wrap(body, width - 10).entries()) {
                above(at === 0 ? `        ${paint(glyph, code)} ${paint(part, DIM)}` : `          ${paint(part, DIM)}`);
            }
        },

        note: (text) => {
            if (mode === "plain") {
                out(`intentic: ${text}\n`);
                return;
            }
            for (const part of wrap(text, width - 8)) {
                above(`        ${paint(part, DIM)}`);
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
                    above(first ? `     ${paint(glyphs.warn, YELLOW)}  ${paint(part, DIM)}` : `        ${paint(part, DIM)}`);
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
                nestedLine(verdict, paint(glyphs.ok, GREEN));
                if (address !== undefined) {
                    nestedLine(address);
                }
                return;
            }
            settle();
            const took = `took ${humanDuration(Date.now() - started)}`;
            const pad = " ".repeat(Math.max(1, width - 6 - [...verdict].length - [...took].length));
            out("\n");
            out(`  ${paint(glyphs.ok, GREEN)}  ${paint(verdict, BOLD)}${pad}${paint(took, DIM)}\n`);
            if (address !== undefined) {
                out(`\n     ${paint(address, CYAN)}\n`);
            }
            if (instruction !== "") {
                out(`\n     ${instruction}\n`);
            }
            if (footnotes.length > 0) {
                out("\n");
                const column = Math.max(...footnotes.map(([what]) => [...what].length));
                for (const [at, [what, command]] of footnotes.entries()) {
                    const heading = (at === 0 ? "later" : "").padEnd(6);
                    out(`${paint(truncate(`     ${heading} ${what.padEnd(column)}   ${command}`, width), DIM)}\n`);
                }
            }
            out("\n");
        },

        fail: (message) => {
            if (mode === "plain") {
                process.stderr.write(`error: ${message}\n`);
                return;
            }
            erase();
            if (mode === "nested") {
                for (const [at, part] of wrap(message, width - 10).entries()) {
                    process.stderr.write(`${at === 0 ? `     ${paint(glyphs.fail, RED)}  ` : "        "}${paint(part, RED)}\n`);
                }
                return;
            }
            const [first = "", ...rest] = message.split("\n");
            process.stderr.write("\n");
            for (const [at, part] of wrap(first, width - 6).entries()) {
                process.stderr.write(`${at === 0 ? `  ${paint(glyphs.fail, RED)}  ` : "     "}${paint(part, RED)}\n`);
            }
            for (const line of rest) {
                const trimmed = line.trimEnd();
                process.stderr.write(trimmed === "" ? "\n" : `  ${trimmed}\n`);
            }
            process.stderr.write("\n");
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
            if (ticker !== undefined) {
                clearInterval(ticker);
                ticker = undefined;
            }
        },
    };
};
