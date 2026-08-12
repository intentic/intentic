import { isAbsolute, resolve } from "node:path";

/* What a check can say, and how the compiler's stdout becomes it.
 *
 * A report distinguishes three states per file, and the caller must keep them apart: diagnostics (a verdict),
 * absence from both lists ("checked, and clean" — also a verdict), and an `unavailable` entry (the checker
 * refusing: it could not load the file's project well enough to vouch for anything, so nothing was checked and
 * nothing should be relayed as if it had been). */

export interface Diagnostic {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly category: string;
    readonly code: number;
    readonly message: string;
}

// One file the checker would not vouch for, and why: its project's config chain or type foundations failed to
// load from where the checker runs, so any diagnostics would be artifacts of that failure, not facts about code.
export interface Unavailable {
    readonly file: string;
    readonly reason: string;
}

export interface DiagReport {
    readonly diagnostics: readonly Diagnostic[];
    readonly unavailable: readonly Unavailable[];
}

// `path(line,col): category TScode: message` — the compiler's own machine format (`--pretty false`). A line
// that starts with whitespace continues the previous diagnostic's message (related-information indents).
const DIAGNOSTIC_LINE = /^(.+)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): (.*)$/;
// Config-level faults print without a location: `error TS5083: Cannot read file '...'`.
const FILELESS_LINE = /^(error|warning) TS(\d+): (.*)$/;

// Parse the compiler's stdout into diagnostics. Relative paths are the compiler's cwd-relative names; `baseDir`
// is that cwd, so every parsed path comes out absolute and comparable.
export const parseCompilerOutput = (output: string, baseDir: string): Diagnostic[] => {
    const diagnostics: Diagnostic[] = [];
    let last: { file: string; line: number; column: number; category: string; code: number; message: string } | undefined;
    for (const line of output.split("\n")) {
        const located = DIAGNOSTIC_LINE.exec(line);
        if (located !== null) {
            last = {
                file: isAbsolute(located[1]!) ? located[1]! : resolve(baseDir, located[1]!),
                line: Number(located[2]),
                column: Number(located[3]),
                category: located[4]!,
                code: Number(located[5]),
                message: located[6]!,
            };
            diagnostics.push(last);
            continue;
        }
        const fileless = FILELESS_LINE.exec(line);
        if (fileless !== null) {
            last = { file: "", line: 0, column: 0, category: fileless[1]!, code: Number(fileless[2]), message: fileless[3]! };
            diagnostics.push(last);
            continue;
        }
        // Continuation of the previous message (indented related spans); anything else is compiler chatter.
        if (last !== undefined && /^\s+\S/.test(line)) {
            last.message += `\n${line}`;
        }
    }
    return diagnostics;
};
