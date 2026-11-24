import { isAbsolute, resolve } from "node:path";

// What a check can say, and how the compiler's stdout becomes it.
// Three states per file: diagnostics (a verdict), absence from both lists (checked and clean, also a verdict), and an
// `unavailable` entry (nothing was checked, so nothing should be relayed as if it had been).

export interface Diagnostic {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly category: string;
    readonly code: number;
    readonly message: string;
}

// One file the checker wouldn't vouch for, and why: its project's config or type foundations failed to load, so any
// diagnostics would be artifacts, not facts about code.
export interface Unavailable {
    readonly file: string;
    readonly reason: string;
}

export interface DiagReport {
    readonly diagnostics: readonly Diagnostic[];
    readonly unavailable: readonly Unavailable[];
}

// Matches the compiler's own machine format (`--pretty false`): `path(line,col): category TScode: message`.
const DIAGNOSTIC_LINE = /^(.+)\((\d+),(\d+)\): (error|warning|suggestion|message) TS(\d+): (.*)$/;
// Matches a config-level fault, which prints with no location.
const FILELESS_LINE = /^(error|warning) TS(\d+): (.*)$/;

// Parses the compiler's stdout into diagnostics.
// Relative paths are relative to the compiler's own cwd (`baseDir`), so every parsed path comes out absolute.
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
        // A continuation of the previous message (indented related-info); anything else is compiler chatter.
        if (last !== undefined && /^\s+\S/.test(line)) {
            last.message += `\n${line}`;
        }
    }
    return diagnostics;
};
