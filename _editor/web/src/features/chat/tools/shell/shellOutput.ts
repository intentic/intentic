import { parseJsonWith } from "@intentic/base/json";
import { codeLangForPath } from "@intentic/code-read";
import { z } from "zod";
import { numberedFileBody } from "../numberedText";
import { type PathRef, ROW_CAP, filtersAre, mostly, parseArgs, pathRef, resolvePath, trimBlankLines } from "./shellArgs";
import { type ShellCommand, type ShellStatement, type ShellToken, commandRows, leadingCd, lexShell } from "./shellLex";
import { type MatchesSection, type PathsSection, listSection, searchSection } from "./shellSearch";

// WHAT A SHELL CALL DID, IN THE SHAPE ITS OUTPUT HAS. A command line is lexed (shellLex.ts), split into the statements it
// ran, and its output cut where the agent itself cut it (`echo ----` between two reads), so each piece can be drawn as
// what it is: a file slice highlighted from its real first line, search hits grouped by file, a status or a log as
// columns, a diff or JSON highlighted. Anything not recognised with confidence stays plain text, exactly as it came.
// Pure and i18n-free; toolPresentation.ts words the summary.

export interface StatusEntry extends PathRef {
    // The two-letter porcelain code, as printed (` M`, `??`, `R `).
    readonly code: string;
}

export interface LogEntry {
    readonly hash: string;
    readonly text: string;
}

export type CommandSection =
    | (PathRef & { readonly kind: `code`; readonly code: string; readonly lang: string | undefined; readonly firstLine: number | undefined })
    | MatchesSection
    | PathsSection
    | { readonly kind: `status`; readonly branch: string | undefined; readonly entries: readonly StatusEntry[] }
    | { readonly kind: `log`; readonly entries: readonly LogEntry[] }
    | { readonly kind: `text`; readonly text: string; readonly lang: string | undefined };

export interface ShellReading {
    // The line as the row shows it: past a leading `cd DIR &&`.
    readonly tokens: readonly ShellToken[];
    // The same, one statement per row, for the fold.
    readonly rows: readonly (readonly ShellToken[])[];
    // Where it ran, when the line said so.
    readonly cwd: string | undefined;
    readonly sections: readonly CommandSection[];
    readonly exitCode: number | undefined;
}

// How much of an output is read at all: Claude's own Bash already stops near here.
const OUTPUT_CAP = 32_000;

const QUIET = new Set([`cd`, `pushd`, `export`, `set`, `unset`, `shopt`, `alias`, `true`, `:`, `source`, `.`, `ulimit`, `umask`]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// FILE SLICES: `sed -n A,Bp F`, `cat [-n] F`, `head [-n N] F`, `tail -n +N F`, `nl -ba F`.
interface Slice {
    readonly path: string;
    readonly firstLine: number | undefined;
    readonly numbered: boolean;
}

const sedSlice = (args: readonly string[]): Slice | undefined => {
    const { flags, positional } = parseArgs(args, new Set());
    const range = /^(\d+)(?:,(?:\d+|\$))?p$/.exec(positional[0] ?? ``);
    if (!flags.has(`n`) || flags.size !== 1 || positional.length !== 2 || range === null) {
        return undefined;
    }
    return { path: positional[1]!, firstLine: Number(range[1]), numbered: false };
};

type Slicer = (args: readonly string[]) => Slice | undefined;

const SLICERS = new Map<string, Slicer>([
    [`sed`, sedSlice],
    [
        `cat`,
        (args) => {
            const { flags, positional } = parseArgs(args, new Set());
            const numbered = flags.has(`n`);
            return positional.length === 1 && flags.size === (numbered ? 1 : 0) ? { path: positional[0]!, firstLine: 1, numbered } : undefined;
        },
    ],
    [
        `head`,
        (args) => {
            const { flags, positional } = parseArgs(args, new Set([`-n`, `--lines`]));
            return positional.length === 1 && [...flags].every((flag) => flag === `n` || flag === `lines`)
                ? { path: positional[0]!, firstLine: 1, numbered: false }
                : undefined;
        },
    ],
    [
        `tail`,
        (args) => {
            const { flags, values, positional } = parseArgs(args, new Set([`-n`, `--lines`]));
            const from = /^\+(\d+)$/.exec(values.get(`n`) ?? values.get(`lines`) ?? ``);
            return positional.length === 1 && [...flags].every((flag) => flag === `n` || flag === `lines`)
                ? { path: positional[0]!, firstLine: from === null ? undefined : Number(from[1]), numbered: false }
                : undefined;
        },
    ],
    [
        `nl`,
        (args) => {
            const { positional } = parseArgs(args, new Set([`-b`]));
            return positional.length === 1 ? { path: positional[0]!, firstLine: 1, numbered: true } : undefined;
        },
    ],
]);

const sliceSection = (head: ShellCommand, filters: readonly ShellCommand[], text: string, cwd: string | undefined): CommandSection | undefined => {
    const [program = ``, ...args] = head.argv;
    const slice = SLICERS.get(program)?.(args);
    if (slice === undefined || head.expands.slice(1).some(Boolean) || !filtersAre(filters, new Set([`head`, `tail`]))) {
        return undefined;
    }
    // A tail after the slice starts it somewhere unknown.
    const firstLine = filters.some((command) => command.argv[0] === `tail`) ? undefined : slice.firstLine;
    const numbered = slice.numbered ? numberedFileBody(text) : undefined;
    if (slice.numbered && numbered === undefined) {
        return undefined;
    }
    return {
        kind: `code`,
        ...pathRef(slice.path, cwd),
        code: numbered?.code ?? text,
        lang: codeLangForPath(slice.path),
        firstLine: numbered?.firstLine ?? firstLine,
    };
};

// GIT: status and log as columns, a patch as a highlighted diff.
const STATUS_LINE = /^([ MADRCUT?!]{2}) (.+)$/;
const LOG_LINE = /^[*|\\/ ]*([0-9a-f]{7,40})\b[ \t]*(.*)$/;
const PATCH_START = /^(?:diff --git |@@ -\d)/m;
const SUMMARY_ONLY = [`stat`, `shortstat`, `numstat`, `name-only`, `name-status`, `oneline`];

const statusSection = (args: readonly string[], text: string, cwd: string | undefined): CommandSection | undefined => {
    const { flags } = parseArgs(args, new Set());
    if (![`s`, `short`, `porcelain`].some((flag) => flags.has(flag))) {
        return undefined;
    }
    const lines = text.split(`\n`).filter((line) => line !== ``);
    const branch = lines[0]?.startsWith(`## `) === true ? lines[0].slice(3) : undefined;
    const body = branch === undefined ? lines : lines.slice(1);
    const entries = body.flatMap((line) => {
        const parsed = STATUS_LINE.exec(line);
        // A rename names both sides; the one to open is where it went.
        const target = parsed?.[2]?.split(` -> `).at(-1);
        return parsed === null || target === undefined ? [] : [{ code: parsed[1]!, path: parsed[2]!, open: resolvePath(target, cwd) }];
    });
    return mostly(entries.length, body.length) || (body.length === 0 && branch !== undefined) ? { kind: `status`, branch, entries } : undefined;
};

const logSection = (text: string): CommandSection | undefined => {
    const lines = text.split(`\n`).filter((line) => line.trim() !== ``);
    const entries = lines.flatMap((line) => {
        const parsed = LOG_LINE.exec(line);
        return parsed === null ? [] : [{ hash: parsed[1]!, text: parsed[2]! }];
    });
    return lines.length > 0 && entries.length === lines.length ? { kind: `log`, entries: entries.slice(0, ROW_CAP) } : undefined;
};

// `git -C dir --no-pager -c k=v sub …` → the subcommand, its args, and where it ran.
interface GitCall {
    readonly sub: string;
    readonly args: readonly string[];
    readonly cwd: string | undefined;
}

const gitParts = (args: readonly string[], cwd: string | undefined): GitCall => {
    let at = 0;
    let here = cwd;
    while (at < args.length && args[at]!.startsWith(`-`)) {
        if (args[at] === `-C`) {
            here = resolvePath(args[at + 1] ?? ``, here);
        }
        at += args[at] === `-C` || args[at] === `-c` ? 2 : 1;
    }
    return { sub: args[at] ?? ``, args: args.slice(at + 1), cwd: here };
};

const gitSection = (head: ShellCommand, filters: readonly ShellCommand[], text: string, cwd: string | undefined): CommandSection | undefined => {
    if (head.argv[0] !== `git` || !filtersAre(filters, new Set([`head`, `tail`]))) {
        return undefined;
    }
    const git = gitParts(head.argv.slice(1), cwd);
    if (git.sub === `status`) {
        return statusSection(git.args, text, git.cwd);
    }
    const { flags } = parseArgs(git.args, new Set());
    const summaryOnly = SUMMARY_ONLY.some((flag) => flags.has(flag) && flag !== `oneline`);
    if (git.sub === `log` && !flags.has(`p`) && !flags.has(`patch`)) {
        return logSection(text);
    }
    if ([`show`, `diff`, `log`].includes(git.sub) && !summaryOnly && PATCH_START.test(text)) {
        return { kind: `text`, text, lang: `diff` };
    }
    return undefined;
};

const diffSection = (head: ShellCommand, text: string): CommandSection | undefined =>
    head.argv[0] === `diff` && /^@@ /m.test(text) ? { kind: `text`, text, lang: `diff` } : undefined;

// Plain output, highlighted only when the whole of it is JSON.
const textSection = (text: string): CommandSection => {
    const trimmed = text.trim();
    const json = /^[[{]/.test(trimmed) && /[\]}]$/.test(trimmed) && parseJsonWith(trimmed, z.unknown()) !== undefined;
    return { kind: `text`, text, lang: json ? `json` : undefined };
};

const RECOGNISERS = [
    sliceSection,
    searchSection,
    listSection,
    gitSection,
    (head: ShellCommand, _filters: readonly ShellCommand[], text: string) => diffSection(head, text),
];

const sectionOf = (statement: ShellStatement, text: string, cwd: string | undefined): CommandSection => {
    const [head, ...filters] = statement.pipeline;
    if (head === undefined) {
        return textSection(text);
    }
    for (const recognise of RECOGNISERS) {
        const section = recognise(head, filters, text, cwd);
        if (section !== undefined) {
            return section;
        }
    }
    return textSection(text);
};

// A statement that prints nothing worth a section: moving, setting, a bare `echo` printing a blank line.
const quiet = (statement: ShellStatement): boolean => {
    const command = statement.pipeline[0];
    if (statement.pipeline.length !== 1 || command === undefined) {
        return false;
    }
    return (
        QUIET.has(command.argv[0] ?? ``) ||
        command.argv.every((word) => ASSIGNMENT.test(word)) ||
        (command.argv[0] === `echo` && command.argv.length === 1)
    );
};

// The line an `echo ----` between two commands prints, which is where the agent meant the output to be cut.
const delimiterOf = (statement: ShellStatement): string | undefined => {
    const command = statement.pipeline[0];
    if (statement.pipeline.length !== 1 || command?.argv[0] !== `echo` || command.expands.some(Boolean) || /^-[neE]+$/.test(command.argv[1] ?? ``)) {
        return undefined;
    }
    const printed = command.argv.slice(1).join(` `).trim();
    return printed === `` ? undefined : printed;
};

interface Step {
    readonly statement: ShellStatement;
    readonly cwd: string | undefined;
    // The line this step prints to mark where one piece of output ends (delimiterOf), when it stands between two others.
    readonly delimiter?: string | undefined;
}

// An echo is a cut only between two commands that print: `echo hello` alone, or a closing `echo done`, is the output.
const withDelimiters = (steps: readonly Step[]): Step[] => {
    const printed = steps.map((step) => delimiterOf(step.statement));
    const first = printed.indexOf(undefined);
    const last = printed.lastIndexOf(undefined);
    return steps.map((step, index) => ({ ...step, delimiter: first !== -1 && index > first && index < last ? printed[index] : undefined }));
};

// The output cut into one piece per run of commands between delimiters; undefined when a delimiter never printed (an
// `&&` chain that stopped early), since the pieces could then not be told apart.
const cut = (steps: readonly Step[], output: string): { steps: Step[]; text: string }[] | undefined => {
    const lines = output.split(`\n`);
    const pieces: { steps: Step[]; text: string }[] = [];
    let group: Step[] = [];
    let at = 0;
    for (const step of steps) {
        const delimiter = step.delimiter;
        if (delimiter === undefined) {
            group.push(step);
            continue;
        }
        const found = lines.findIndex((line, index) => index >= at && line.trim() === delimiter);
        if (found === -1) {
            return undefined;
        }
        pieces.push({ steps: group, text: lines.slice(at, found).join(`\n`) });
        group = [];
        at = found + 1;
    }
    pieces.push({ steps: group, text: lines.slice(at).join(`\n`) });
    return pieces;
};

// Each statement with the directory it runs in, following the `cd`s before it; the quiet ones left out.
const stepsOf = (statements: readonly ShellStatement[], cwd: string | undefined): Step[] => {
    const steps: Step[] = [];
    let here = cwd;
    for (const statement of statements) {
        const command = statement.pipeline[0];
        if (command?.argv[0] === `cd` && command.argv.length === 2 && command.expands[1] !== true) {
            here = resolvePath(command.argv[1]!, here);
        }
        if (!quiet(statement)) {
            steps.push({ statement, cwd: here });
        }
    }
    return steps;
};

const sectionsOf = (statements: readonly ShellStatement[], output: string, heredoc: boolean): CommandSection[] => {
    const steps = heredoc ? [] : withDelimiters(stepsOf(statements, undefined));
    const pieces = cut(steps, output) ?? [{ steps: steps.filter((step) => step.delimiter === undefined), text: output }];
    return pieces.flatMap(({ steps: ran, text }) => {
        const trimmed = trimBlankLines(text);
        if (trimmed === ``) {
            return [];
        }
        const only = ran.length === 1 ? ran[0] : undefined;
        return [only === undefined ? textSection(trimmed) : sectionOf(only.statement, trimmed, only.cwd)];
    });
};

// Claude Code answers a failed command with `Exit code N` above its output.
const EXIT_LINE = /^Exit code (\d+)\r?\n?/;

export const readShell = (
    command: string,
    output: string,
    { failed, exitCode }: { readonly failed: boolean; readonly exitCode: number | undefined },
): ShellReading => {
    const line = lexShell(command);
    const cd = leadingCd(line);
    const tokens = cd === undefined ? line.tokens : line.tokens.slice(cd.next);
    const exit = failed ? EXIT_LINE.exec(output) : null;
    const text = (exit === null ? output : output.slice(exit[0].length)).slice(0, OUTPUT_CAP);
    return {
        tokens,
        rows: commandRows(tokens),
        cwd: cd?.dir,
        sections: sectionsOf(line.statements, text, line.heredoc),
        exitCode: exitCode ?? (exit === null ? undefined : Number(exit[1])),
    };
};

/** How many lines a piece of text has, not counting a final newline. */
export const lineCountOf = (text: string): number => (text === `` ? 0 : text.replace(/\n$/, ``).split(`\n`).length);
