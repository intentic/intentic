/* EVERY BYTE A LOCAL AGENT SHOWS A PERSON, IN ONE PLACE, and the reason it can be pretty at all.
 *
 * The shapes below are a CONTRACT, not house style, docs/cli-output-protocol.md writes down the line format,
 * the three modes and the row vocabulary, and both implementations answer to it.
 *
 * This is the TypeScript twin of `ic`'s `_sandbox/ic/src/ui.rs`, and it exists for the same reason `text.ts`
 * beside it does: three agents ship to a user's machine, each grew its own `out()` closure writing straight to
 * stdout, and every improvement to how one of them reads landed in exactly one of them. The install the user
 * actually experiences is `ic` and these agents in sequence, so "three voices" is not an abstraction problem,
 * it is what setup looks like on the screen.
 *
 * THE SPLIT IS THE WHOLE DESIGN. Output here is read by two audiences that want opposite things:
 *
 *   • a PIPE, the desktop app spawns the install with redirected stdio and turns `intentic: [phase] message`
 *     markers into a progress bar; CI redirects it into a log. These need output that never changes shape.
 *   • a TERMINAL, a person, who needs hierarchy, colour, and a sense of how much is left.
 *
 * So `plain` emits the marker stream and nothing else, and `rich` is free to redraw. A third mode, `nested`,
 * is what makes the install read as ONE program: these agents are also spawned BY `ic` in the middle of its
 * own checklist, and a second banner with a second plan inside somebody else's install is exactly the "these
 * are different programs" seam this was written to remove. Nested renders as indented detail under whichever
 * step the parent is running, no banner, no live line, no spinner.
 *
 * THE LIVE REGION IS EXACTLY ONE LINE, for the reason ui.rs gives at length: redrawing a checklist in place
 * needs the cursor moved up N lines, which needs to know when a line wrapped, and these run under `curl | sh`
 * on terminals of unknown width. A carriage return plus a truncation needs none of that.
 *
 * Consequence, and the one rule callers follow: anything that writes to the same stdout WITHOUT going through
 * this (a spawned child, a downloader's own output) is bracketed by `suspend()` / `resume()`.
 *
 * No dependencies, like everything else in this package, these agents ship as single-file compiled binaries
 * and a rendering library is not worth bytes in one.
 */

/** How a run renders. Chosen once, from the environment, see [`createUi`]. */
export type UiMode = "rich" | "plain" | "nested";

/**
 * One step of a flow as the reader meets it: the phase id the wire carries, the words a person reads, and
 * roughly how long it takes.
 *
 * Weights are seconds and they are guesses. They exist so the estimate is about TIME left rather than STEPS
 * left, "4 of 5" on the near side of a ninety-second download is a lie a step counter tells and a weighted
 * estimate does not. They are only ever compared, never shown.
 */
export interface PlanStep {
    readonly phase: string;
    readonly label: string;
    readonly weight: number;
}

/** A settled verdict about one thing. Same vocabulary as `ic`'s rows, so a user meeting both learns one. */
export type RowOutcome = "pass" | "warn" | "fail" | "skip";

/** A footnote on a finished run: what it does, and the command that does it. */
export type Footnote = readonly [what: string, command: string];

export interface Ui {
    readonly mode: UiMode;
    /** Banner plus the promise about scope and time. No-op outside `rich`. */
    begin: (title: string, plan?: readonly PlanStep[]) => void;
    /** A phase of the flow, announced once, the marker on the wire, a checklist row on a screen. */
    step: (phase: string, message: string) => void;
    /** Replace the running step's sub-detail. Rich only: in `plain` this is narration nobody asked for. */
    detail: (text: string) => void;
    /** A changing measurement (bytes downloaded). A pipe gets every reading; a screen gets the newest. */
    progress: (text: string) => void;
    row: (outcome: RowOutcome, name: string, note?: string) => void;
    /** Narration under the running step. The `intentic: ` prefix is part of the plain contract and added here. */
    note: (text: string) => void;
    /** A caution, degraded, not broken. Goes to stderr in `plain`, as these agents' notes always have. */
    warn: (text: string) => void;
    /** The end of a successful run: one address, one instruction, then footnotes. */
    finished: (verdict: string, address: string | undefined, instruction: string, footnotes?: readonly Footnote[]) => void;
    /** The frame around a stopped run. The words are the caller's; this supplies only that it STOPPED. */
    fail: (message: string) => void;
    /** Hand the terminal to a child process that writes its own output. */
    suspend: () => void;
    resume: () => void;
    /** Settle the running step and stop repainting. Safe to call twice; every entry point ends in one. */
    close: () => void;
}

// ── what the renderer needs from the outside ────────────────────────────────

/**
 * The process seams this reads. Matches the shape stricli injects as `this.process`, so a command passes its
 * own context straight in and a test passes a fake, nothing here reaches for the global `process`.
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
// Windows consoles that never got virtual-terminal processing print the set above as mojibake.
const ASCII: Glyphs = { ok: "+", fail: "x", warn: "!", skip: "-", spinner: ["|", "/", "-", "\\"] };

// Written as \u001b escapes, never the literal byte: a control character in a source file makes git, grep
// and every diff viewer treat it as binary (_tools/scripts/control-chars.mjs enforces this repo-wide).
const DIM = "\u001b[2m";
const BOLD = "\u001b[1m";
const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const RESET = "\u001b[0m";

/** How often the spinner repaints. Fast enough to read as motion, slow enough to be free. */
const TICK_MS = 110;
/** Below this, a countdown stops helping and starts being wrong on every repaint. */
const ESTIMATE_FLOOR_SECONDS = 20;

// ── pure helpers, exported for their tests ──────────────────────────────────

/**
 * Fold `text` onto lines of at most `width`. Everything that SETTLES on the screen wraps, a caution, a
 * check's note, a diagnosis, because truncating those loses the words that make them worth printing. Only
 * the live line truncates, and only because it is repainted and must never wrap.
 *
 * A single word longer than the width is left to overflow: it is a URL or a container name, and breaking one
 * mid-token to protect a margin makes it useless for the copy-paste it exists for.
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

/** Clip to `limit`, marking the cut. Only ever used on the repainted line, which must not wrap. */
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

/** A duration as a person would say it. Precise while that is interesting, round once it is not. */
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
 * Time left, from the plan's remaining weight and the pace this run has actually kept.
 *
 * Clamped, because one slow step on a fast machine (or the reverse) should nudge the estimate rather than
 * replace it, an estimate that swings is worse than a rough one that holds still. `undefined` while there is
 * not yet enough evidence to say anything, and below the floor where a countdown stops helping.
 */
export const estimate = (totalWeight: number, consumed: number, elapsedSeconds: number): string | undefined => {
    if (totalWeight <= 0 || consumed < 1) {
        return undefined;
    }
    const pace = Math.min(3, Math.max(0.5, elapsedSeconds / consumed));
    const left = Math.max(0, (totalWeight - consumed) * pace);
    return left < ESTIMATE_FLOOR_SECONDS ? undefined : humanDuration(left * 1000);
};

/** Sentence-case a step's own prose, for flows whose phase the plan does not carry. */
export const asLabel = (message: string): string => {
    const trimmed = message.replace(/[…. ]+$/u, "");
    return trimmed === "" ? "" : trimmed[0]!.toUpperCase() + trimmed.slice(1);
};

// ── the renderer ────────────────────────────────────────────────────────────

/**
 * Decide how this run renders, once.
 *
 * `INTENTIC_UI` forces a mode outright, which is what `ic` sets to `nested` when it spawns one of these
 * agents mid-install. Otherwise a terminal is `rich` and anything else is `plain`, the same single question
 * (`isTTY`) that `ic` asks, and the reason a pipe can never reach the redrawing path.
 */
const detectMode = (process: UiProcess): UiMode => {
    const forced = process.env?.["INTENTIC_UI"];
    if (forced === "plain" || forced === "rich" || forced === "nested") {
        return forced;
    }
    // The historical escape hatch ic also honours, kept spelled the same.
    if (process.env?.["INTENTIC_PLAIN"] === "1") {
        return "plain";
    }
    return process.stdout.isTTY === true ? "rich" : "plain";
};

export const createUi = (process: UiProcess): Ui => {
    const mode = detectMode(process);
    const env = process.env ?? {};
    const colour = mode !== "plain" && (env["FORCE_COLOR"] !== undefined || env["NO_COLOR"] === undefined);
    // A terminal that reports a width is believed; 80 is the floor every terminal has agreed on since 1978.
    // Being wrong low costs a shorter line; being wrong high wraps the one line we repaint and corrupts it.
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

    /** How far into the running step we are, 0..1, the clock against this step's own weight, capped short of
     * the end, because a timer that reaches 100% claims a step is finished when only the flow knows that. */
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
        // Spaces rather than an erase-to-end-of-line escape: this is the one repaint that has to work on a
        // console with no virtual-terminal processing, where an escape would print as literal text.
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
        // The line must never reach the last column, or the terminal wraps it and the carriage return above
        // no longer returns to its start.
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

    /** Print something ABOVE the live line: erase, write, redraw. */
    const above = (text: string): void => {
        erase();
        out(`${text}\n`);
        repaint();
    };

    /** Repaint on a timer so a wait is never mistaken for a hang. Unref'd: a spinner must never be the reason
     * a CLI does not exit. */
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
     * Turn the running step into a settled line. Its duration is the point: afterwards a ninety-second
     * download and a half-second check look identical, and neither the user nor whoever reads their pasted
     * transcript can tell which part was slow.
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
        // Padding is measured on the UNPAINTED line, colour escapes are zero-width on screen and would
        // otherwise push the duration off the right edge by however many bytes they happen to be.
        const bare = `  x  ${String(ordinal).padStart(2)}  ${label}`;
        const pad = " ".repeat(Math.max(0, width - 1 - [...bare].length - [...took].length));
        out(`  ${paint(glyphs.ok, GREEN)}  ${paint(String(ordinal).padStart(2), DIM)}  ${label}${pad}${paint(took, DIM)}\n`);
        label = "";
        detailText = "";
    };

    /** Indented dim narration, how everything reads in `nested`, and how detail reads in `rich`. */
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
                // Inside somebody else's checklist a step is not a step, it is detail under theirs.
                nestedLine(asLabel(message));
                return;
            }
            settle();
            const found = plan.findIndex((planned) => planned.phase === phase);
            // The cursor only ever goes forward: a phase already passed is narration, not a step.
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
                const tail = note === "" ? "" : ` — ${note}`;
                const word = outcome === "pass" ? "ok  " : outcome === "fail" ? "FAIL" : outcome === "warn" ? "warn" : "skip";
                out(`  ${word}  ${name}${tail}\n`);
                return;
            }
            const glyph = outcome === "pass" ? glyphs.ok : outcome === "fail" ? glyphs.fail : outcome === "warn" ? glyphs.warn : glyphs.skip;
            const code = outcome === "pass" ? GREEN : outcome === "fail" ? RED : outcome === "warn" ? YELLOW : DIM;
            const body = note === "" ? name : `${name} — ${note}`;
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
                // The parent owns the ending. All this contributes is the one fact worth carrying up.
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
