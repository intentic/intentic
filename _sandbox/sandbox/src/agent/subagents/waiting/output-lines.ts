import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { plainText } from "@intentic/base/plain-text";
import { OUTPUT_FILE } from "../../tools/jobs/job-files.js";
import { redirectedOutput } from "../../tools/jobs/job-redirects.js";
import { type FileRange, readFileAt, readRunFileAt } from "../../tools/jobs/run-files.js";

/* A JOB'S OUTPUT READ ON FROM WHERE THE LAST LOOK LEFT IT (2026-11-19, the shinobi-society audit). Agents spent 44 hours
   in waits on their own background commands: 35 of 181 such waits timed out, 27 jobs were waited on more than once, and
   between waits they read the log with `tail` and `cat` 164 times and built "until this line" waits by hand
   (`tail -f log | grep -m1 "done in|FAILED"`, `until …; do read -t 10 </dev/zero` to get round the ban on sleep). This
   is the reading `wait` does instead: a job's output from a mark, one complete line at a time, so a pattern ends a wait
   at the line it names and a timeout says how much was printed since the last answer. */

/** How far a job's output has been read. */
export interface OutputMark {
    // The file read: the job's capture, or the file its output is sent to (job-redirects.ts).
    readonly path: string;
    // Bytes read so far: always the end of a line, so a line still being written is read whole the next time.
    readonly offset: number;
    // Lines read so far, which numbers the next one.
    readonly lines: number;
}

export interface OutputLine {
    // From the file's start, 1-based; past a skip (OutputRead.skipped) it counts only the lines read.
    readonly number: number;
    // Terminal escapes removed and a progress bar's redraws folded to what was last on screen (plain-text.ts).
    readonly text: string;
}

/** The first line a pattern matched, and the lines read just before and just after it. */
export interface OutputMatch {
    readonly line: OutputLine;
    readonly before: readonly OutputLine[];
    readonly after: readonly OutputLine[];
}

export interface OutputRead {
    // Where the next read starts: past the matched line, else past the last complete line read.
    readonly mark: OutputMark;
    // The file's size at this read, and the bytes and complete lines that came after the mark it started from.
    readonly size: number;
    readonly bytes: number;
    readonly lines: number;
    // Bytes jumped over unread, when more had come since the mark than one read takes.
    readonly skipped: number;
    // The last few lines read, and the line still being written after them (a progress bar's frame on screen), only
    // when no pattern was asked; with one that matched nothing, the last lines read, for the next match's context.
    readonly last: readonly OutputLine[];
    readonly unfinished?: string;
    readonly matched?: OutputMatch;
}

// Most bytes one read goes through; past it a read takes the newest that many and counts the rest as skipped.
const READ_CAP = 16 * 1024 * 1024;
// Lines a read keeps from its end, and how many a match is shown with on either side.
const LAST_KEPT = 5;
const CONTEXT_LINES = 3;
// Longest line handed back in words; a match is tested against the whole line.
const LINE_CHARS = 300;
const NEWLINE = 10;

/** Where a read of `dir`'s job starts when nothing was read yet: its capture's first byte. */
export const captureStart = (dir: string): OutputMark => ({ path: join(dir, OUTPUT_FILE), offset: 0, lines: 0 });

// The capture through run-files.ts, never a link planted in a fenced turn's dir; a redirect is the job's own file.
const readAt = (dir: string, path: string, offset: number, bytes: number): FileRange =>
    path === join(dir, OUTPUT_FILE) ? readRunFileAt(dir, OUTPUT_FILE, offset, bytes) : readFileAt(path, offset, bytes);

const lineText = (bytes: Buffer): string => plainText(bytes.toString("utf8"));

/** A line as it is handed back: cut to a readable length. */
export const shownLine = (line: OutputLine): string => (line.text.length > LINE_CHARS ? `${line.text.slice(0, LINE_CHARS)}…` : line.text);

// Up to `count` complete lines of `data` from `at`, numbered on from `after`.
const linesFrom = (data: Buffer, at: number, after: number, count: number): OutputLine[] => {
    const lines: OutputLine[] = [];
    let start = at;
    while (lines.length < count && start < data.length) {
        const end = data.indexOf(NEWLINE, start);
        if (end === -1) {
            break;
        }
        lines.push({ number: after + lines.length + 1, text: lineText(data.subarray(start, end)) });
        start = end + 1;
    }
    return lines;
};

// The last `count` complete lines of data[0, end), numbered so the last is `lastNumber`.
const lastLines = (data: Buffer, end: number, lastNumber: number, count: number): OutputLine[] => {
    const lines: OutputLine[] = [];
    let stop = end;
    while (lines.length < count && stop > 0) {
        // From before the line's own newline; a negative offset would count from the buffer's end.
        const start = stop >= 2 ? data.lastIndexOf(NEWLINE, stop - 2) + 1 : 0;
        const text = data.subarray(start, data[stop - 1] === NEWLINE ? stop - 1 : stop);
        lines.unshift({ number: lastNumber - lines.length, text: lineText(text) });
        stop = start;
    }
    return lines;
};

// Counts newline bytes in data[0, end).
const newlines = (data: Buffer, end: number): number => {
    let count = 0;
    for (let at = data.indexOf(NEWLINE); at !== -1 && at < end; at = data.indexOf(NEWLINE, at + 1)) {
        count += 1;
    }
    return count;
};

// The bytes one read goes through, where in the file they start, and the file's size then.
interface OutputWindow {
    readonly data: Buffer;
    readonly start: number;
    readonly size: number;
}

// Everything since the mark, or past the cap the newest bytes from a line's start.
const readWindow = (dir: string, from: OutputMark, cap: number): OutputWindow => {
    const first = readAt(dir, from.path, from.offset, cap);
    if (first.size - from.offset <= cap) {
        return { data: first.data, start: from.offset, size: first.size };
    }
    const tail = readAt(dir, from.path, first.size - cap, cap);
    const cut = tail.data.indexOf(NEWLINE) + 1;
    return { data: tail.data.subarray(cut), start: first.size - cap + cut, size: tail.size };
};

// A read that found nothing to read: the file gone, unreadable, or the mark at its end.
const nothing = (from: OutputMark, size = from.offset): OutputRead => ({ mark: from, size, bytes: 0, lines: 0, skipped: 0, last: [] });

/**
 * Reads `dir`'s job output on from `from`, one complete line at a time; `final` reads the unfinished last line too, for a
 * command that has exited. With `until`, stops at the first line it matches, and the mark stops just past that line.
 * Never throws: a file gone or unreadable reads as nothing new.
 */
export const readOutputOn = (dir: string, from: OutputMark, options: { readonly until?: RegExp; readonly final?: boolean; readonly cap?: number } = {}): OutputRead => {
    let read: OutputWindow;
    try {
        read = readWindow(dir, from, options.cap ?? READ_CAP);
    } catch {
        // allow(silent-catch): a capture swept or a log removed since has nothing more to read, which the read says as nothing new.
        return nothing(from);
    }
    // Shorter than the mark: the file was replaced or truncated (a log rewritten by `>`), so it is read from its start.
    if (read.size < from.offset) {
        return from.offset === 0 ? nothing(from, read.size) : readOutputOn(dir, { path: from.path, offset: 0, lines: 0 }, options);
    }
    const { data, start, size } = read;
    const skipped = start - from.offset;
    const lastNewline = data.lastIndexOf(NEWLINE);
    const whole = options.final === true ? data.length : lastNewline + 1;
    const unfinished = options.final === true && data.length > 0 && data.at(-1) !== NEWLINE ? 1 : 0;
    if (options.until === undefined) {
        const lines = newlines(data, whole) + unfinished;
        const mark = { path: from.path, offset: start + whole, lines: from.lines + lines };
        const rest = lineText(data.subarray(whole)).trim();
        const counted = { mark, size, bytes: size - from.offset, lines, skipped, last: lastLines(data, whole, mark.lines, LAST_KEPT) };
        return rest === "" ? counted : { ...counted, unfinished: shownLine({ number: mark.lines + 1, text: rest }) };
    }
    const before: OutputLine[] = [];
    let at = 0;
    let number = from.lines;
    while (at < whole) {
        const end = data.indexOf(NEWLINE, at);
        const stop = end === -1 || end >= whole ? whole : end;
        number += 1;
        const line = { number, text: lineText(data.subarray(at, stop)) };
        at = Math.min(whole, stop + 1);
        if (options.until.test(line.text)) {
            const matched = { line, before: before.slice(-CONTEXT_LINES), after: linesFrom(data, at, number, CONTEXT_LINES) };
            return { mark: { path: from.path, offset: start + at, lines: number }, size, bytes: size - from.offset, lines: number - from.lines, skipped, last: [], matched };
        }
        before.push(line);
        if (before.length > CONTEXT_LINES) {
            before.shift();
        }
    }
    return { mark: { path: from.path, offset: start + whole, lines: number }, size, bytes: size - from.offset, lines: number - from.lines, skipped, last: before };
};

/** A match as a wait hands it over. */
export interface ShownMatch {
    readonly line: string;
    readonly lineNumber: number;
    // The lines around it as far as they were read, each with its number, the matching one marked `>`.
    readonly context: string;
}

export const matchShown = (match: OutputMatch): ShownMatch => ({
    line: shownLine(match.line),
    lineNumber: match.line.number,
    context: [...match.before, match.line, ...match.after]
        .map((line) => `${line === match.line ? ">" : " "} ${String(line.number)}: ${shownLine(line)}`)
        .join("\n"),
});

/** A pattern a wait reads output for: JavaScript's syntax, case-sensitive unless it starts with `(?i)`. */
export const outputPattern = (text: string): RegExp | { readonly error: string } => {
    const fold = text.startsWith("(?i)");
    const source = fold ? text.slice(4) : text;
    if (source === "") {
        return { error: "`until` as a pattern needs something to match: an empty one matches every line." };
    }
    try {
        return new RegExp(source, fold ? "i" : "");
    } catch (error) {
        return { error: `\`until\` is not a regular expression: ${errorMessage(error)}` };
    }
};

// How often a follow whose capture is still empty asks /proc whether the job's output went to a file instead.
const REDIRECT_LOOK_MS = 5_000;

export interface OutputFollow {
    // Reads on from the last look; the first line the pattern matches answers, with the lines around it. `final` reads the
    // unfinished last line too, once the command has exited.
    readonly look: (final: boolean) => Promise<OutputMatch | undefined>;
    // Where the reading stands: just past the matched line once one matched.
    readonly mark: () => OutputMark;
}

/**
 * Follows `dir`'s job output for `pattern` from `from` (its capture's start when nothing was read yet). While the
 * capture is still empty, the file the job's processes write to instead (`cmd > log 2>&1`) is followed once found.
 */
export const followOutput = (dir: string, from: OutputMark | undefined, pattern: RegExp, procRoot = "/proc"): OutputFollow => {
    let mark = from ?? captureStart(dir);
    let askedAt = Number.NEGATIVE_INFINITY;
    let matched: OutputMatch | undefined;
    // The last lines an earlier look read, which a match at the start of a later one is shown after.
    let seen: readonly OutputLine[] = [];
    const capture = join(dir, OUTPUT_FILE);
    const look = async (final: boolean): Promise<OutputMatch | undefined> => {
        if (matched !== undefined) {
            return matched;
        }
        const read = readOutputOn(dir, mark, { until: pattern, final });
        mark = read.mark;
        matched = read.matched === undefined ? undefined : { ...read.matched, before: [...seen, ...read.matched.before].slice(-CONTEXT_LINES) };
        seen = [...seen, ...read.last].slice(-CONTEXT_LINES);
        if (matched === undefined && mark.path === capture && read.size === 0 && Date.now() - askedAt >= REDIRECT_LOOK_MS) {
            askedAt = Date.now();
            const redirect = await redirectedOutput(dir, procRoot);
            if (redirect !== undefined) {
                mark = { path: redirect.path, offset: 0, lines: 0 };
                return look(final);
            }
        }
        return matched;
    };
    return { look, mark: () => mark };
};
