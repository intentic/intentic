/* WHAT A FAILED RUN SAYS, ONCE, IN THE ORDER A FIXER READS IT.

   A run on main fails several jobs at once more often than one (median 2, p90 6 across September 2026), and most of
   those are one cause printed several times: a type error in a shared package fails every verify group that compiles
   it, a broken suite fails verify-core and both clock legs. The log tail each job used to send hid that: 24 KB of
   whichever job came first, and the type errors of a job whose tests ran after its typecheck had scrolled out of every
   tail. So each failed job's whole log is read once, and only what its failed steps printed is kept: the lines that
   name an error, and those steps' own last lines. A run's digest then lists each error once, with every job that
   printed it, before the steps' own words. Pure, so what a log means can be tested without a forge. */

// One failed job as heard: its name, its page, the steps that failed it (GitHub names them; GitLab has none), and its
// log as plain text, whole.
export interface FailedJobLog {
    readonly name: string;
    readonly url?: string | undefined;
    readonly steps: readonly string[];
    readonly log: string;
}

// What is kept of one failed job between hearing it and handing its run over: bounded, so a run's batch costs kilobytes
// however long its logs were.
export interface JobExcerpt {
    readonly name: string;
    readonly url?: string | undefined;
    readonly steps: readonly string[];
    // Each error the failed steps printed, normalized, once per job, first seen first.
    readonly errors: readonly string[];
    // The failed steps' own last lines, or the log's when it marks no steps (a GitLab trace).
    readonly tail: string;
}

// The whole digest a fix agent is handed for one run: enough to name every cause, not a log.
export const DIGEST_BYTES = 32_000;
// Errors kept per job, and the most the error list may take of the digest, so the failed steps' own words always fit.
const ERRORS_PER_JOB = 40;
const ERRORS_SHARE = 0.45;
const ERROR_LINE_MAX = 300;
// A failed step's last lines kept per job before the digest cuts them to its share.
const TAIL_KEPT = 8_000;
// Findings kept under one failed check (`✗ id` and its `- ` lines), so a check with hundreds cannot fill the list.
const FINDINGS_PER_CHECK = 6;
// How far below a failed check its findings may sit, past the paragraph that explains the rule.
const CHECK_LOOKAHEAD = 60;
// How far below an error its place may be named (rustc's `-->`, oxlint's `╭─[`).
const PLACE_LOOKAHEAD = 3;
// Words that mark a line worth keeping in a failed step that printed none of the shapes below.
const GENERIC_ERROR = /\b(?:error|Error|ERROR|failed|Failed|FAILED|fatal|panicked)\b|✗/;
const GENERIC_KEPT = 3;
const GENERIC_WINDOW = 40;
// A step name in the digest's header, cut: some are a whole command line.
const STEP_NAME_MAX = 90;

// GitHub's per-line timestamp, and the byte-order mark its log opens with.
const TIMESTAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;
// A step begins with its command as a group; it failed when the runner closes it with an exit code.
const STEP_START = /^##\[group\]Run (.*)$/;
const STEP_FAILED = /^##\[error\]Process completed with exit code \d+/;
const ANY_ERROR_MARK = /^##\[error\]/;
const GROUP_TITLE = /^##\[group\](.*)$/;
const GROUP_END = "##[endgroup]";

// Where a line came from inside a failed step: the turbo task it belongs to, and the test file bun is reporting. A
// failed turbo task's output is printed outside any group, under a bare `@scope/pkg:task` line.
const TURBO_GROUP = /^##\[group\](@?[\w.-]+(?:\/[\w.-]+)?):[\w:-]+$/;
const TURBO_TASK_LINE = /^(@[\w.-]+\/[\w.-]+):[\w:-]+$/;
const TURBO_PREFIX = /^(@?[\w.-]+(?:\/[\w.-]+)?)[#:][\w:-]+: +/;
const TEST_FILE_GROUP = /^##\[group\](.+\.(?:test|spec)\.[cm]?[jt]sx?):$/;

// The shapes an error takes in what this repository's jobs run.
const TS_ERROR = /\berror TS\d+:/;
const TEST_FAIL = /^\(fail\) (.+?)(?: \[\d+(?:\.\d+)?m?s\])?$/;
const TEST_SETTLED = /^\((?:pass|skip|todo)\) /;
const PLAIN_ERROR = /^error(?:\[E\d+\])?: (.+)$/;
const RUST_PLACE = /^\s*--> (.+)$/;
const RUSTFMT = /^Diff in (.+?) at line (\d+)/;
const CARGO_TEST = /^test (\S+) \.\.\. FAILED$/;
const CHECK_FAILED = /^\s*✗ (.+)$/;
const CHECK_NEXT = /^\s*(?:[✗⚠?] |checks: |verify-push: )/;
const FINDING = /^\s*- (.+)$/;
const TURBO_FAILED = /^Failed:\s+(.+)$/;
const PNPM_ERROR = /\bERR_PNPM_[A-Z_]+\b.*/;
const PLAYWRIGHT_FAIL = /^\s*\d+\) \[[\w-]+\] › .+$/;
const JEST_FAIL = /^\s*FAIL\s+\S.*$/;
const LINT_ERROR = /^\s*[×✖] (.+)$/;
const LINT_PLACE = /^\s*[╭┌]─\[(.+)\]$/;

// The same error printed by two jobs must read as one, so what differs between runners goes: the checkout's absolute
// path, a test's duration, runs of spaces.
const WORKSPACE_PATH = /(?:\/__w|\/home\/runner\/work)\/[^/\s]+\/[^/\s]+\//g;
const DURATION = /\s*[[(]\d+(?:\.\d+)?m?s[\])]$/;

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

export const normalizeErrorLine = (line: string): string =>
    clip(line.replace(WORKSPACE_PATH, "").replace(DURATION, "").replace(/\s+/g, " ").trim(), ERROR_LINE_MAX);

// The log's lines without the runner's timestamps.
const linesOf = (log: string): string[] => log.split("\n").map((line) => line.replace(TIMESTAMP, "").replace(/\r$/, ""));

// The failed steps, each as its lines, up to the exit code that closed it (what follows the last one is the runner's
// own cleanup). A log that marks no steps is one step (a GitLab trace); one whose steps are marked but none closed with
// an exit code (a cancel, a timeout) keeps the steps that carry any error mark, else its last.
const failedSteps = (lines: readonly string[]): string[][] => {
    const starts = lines.flatMap((line, index) => (STEP_START.test(line) ? [index] : []));
    if (starts.length === 0) {
        return [[...lines]];
    }
    const steps = starts.map((start, index) => lines.slice(start, starts[index + 1] ?? lines.length));
    const failed = steps.flatMap((step) => {
        const closed = step.findIndex((line) => STEP_FAILED.test(line));
        return closed < 0 ? [] : [step.slice(0, closed + 1)];
    });
    if (failed.length > 0) {
        return failed;
    }
    const marked = steps.filter((step) => step.some((line) => ANY_ERROR_MARK.test(line)));
    return marked.length > 0 ? marked : steps.slice(-1);
};

// A step as a reader wants it: its command once, then what it printed, without the env block the runner echoes or the
// group markers (a group's title stays, as the line it is).
const stepText = (step: readonly string[]): string[] => {
    const command = STEP_START.exec(step[0] ?? "")?.[1];
    const headerEnd = command === undefined ? -1 : step.indexOf(GROUP_END);
    const body = command === undefined ? step : step.slice(headerEnd < 0 ? 1 : headerEnd + 1);
    const printed = body.flatMap((line) => {
        if (STEP_FAILED.test(line) || line === GROUP_END) {
            return [];
        }
        return [GROUP_TITLE.exec(line)?.[1] ?? line];
    });
    return command === undefined ? printed : [`$ ${command}`, ...printed];
};

// The last `bytes` of a text, cut at a line so no line arrives half.
const lastBytes = (text: string, bytes: number): string => {
    if (text.length <= bytes) {
        return text;
    }
    const cut = text.slice(-bytes);
    const newline = cut.indexOf("\n");
    return `…\n${newline < 0 ? cut : cut.slice(newline + 1)}`;
};

// Where a line came from inside a failed step, as the lines before it said.
interface Place {
    task: string | undefined;
    file: string | undefined;
    // A test's failure message, said before the `(fail)` line it belongs to.
    testError: string | undefined;
    // Tests already reported failing in this step, by task and name: bun repeats every `(fail)` line in its closing
    // summary, outside the file it belongs to and without its message, and the first saying is the one worth keeping.
    readonly failed: Set<string>;
}

const tagged = (place: Place, line: string): string => `${place.task === undefined ? "" : `${place.task}: `}${line}`;

// A line that only says where the next ones come from: a turbo task, a test file, a group's end.
const placeMarker = (raw: string, place: Place): boolean => {
    const task = (TURBO_GROUP.exec(raw) ?? TURBO_TASK_LINE.exec(raw))?.[1];
    if (task !== undefined) {
        Object.assign(place, { task, file: undefined, testError: undefined });
        return true;
    }
    const file = TEST_FILE_GROUP.exec(raw)?.[1];
    if (file !== undefined) {
        Object.assign(place, { file, testError: undefined });
        return true;
    }
    if (raw === GROUP_END) {
        place.file = undefined;
        return true;
    }
    return false;
};

// The line without turbo's `pkg:task: ` prefix, the prefix naming the task it belongs to.
const unprefixed = (raw: string, place: Place): string => {
    const prefix = TURBO_PREFIX.exec(raw);
    if (prefix === null) {
        return raw;
    }
    place.task = prefix[1];
    return raw.slice(prefix[0].length);
};

// The place an error names a few lines below it, when it names one.
const placeBelow = (step: readonly string[], index: number, marker: RegExp): string | undefined =>
    step
        .slice(index + 1, index + 1 + PLACE_LOOKAHEAD)
        .map((next) => marker.exec(next)?.[1])
        .find((place) => place !== undefined);

// The findings a failed check lists under its `✗` line, up to the next check's verdict.
const findingsUnder = (step: readonly string[], index: number): string[] => {
    const below = step.slice(index + 1, index + 1 + CHECK_LOOKAHEAD);
    const end = below.findIndex((next) => CHECK_NEXT.test(next));
    return (end < 0 ? below : below.slice(0, end))
        .flatMap((next) => {
            const finding = FINDING.exec(next)?.[1];
            return finding === undefined ? [] : [normalizeErrorLine(finding)];
        })
        .slice(0, FINDINGS_PER_CHECK);
};

// One shape a line can take: what it says when the line has that shape, undefined when it does not. A reader may note
// something for the lines after it (a test's message waits for its `(fail)` line) and still say nothing.
type Reader = (line: string, step: readonly string[], index: number, place: Place) => string | undefined;

const matching =
    (pattern: RegExp, say: (match: RegExpExecArray, place: Place) => string): Reader =>
    (line, _step, _index, place) => {
        const match = pattern.exec(line);
        return match === null ? undefined : say(match, place);
    };

const testFailure: Reader = (line, _step, _index, place) => {
    const name = TEST_FAIL.exec(line)?.[1];
    if (name === undefined) {
        return undefined;
    }
    const why = place.testError;
    place.testError = undefined;
    const key = `${place.task ?? ""}\n${name}`;
    if (place.failed.has(key)) {
        return undefined;
    }
    place.failed.add(key);
    const file = place.file === undefined ? "" : `${place.file}: `;
    return tagged(place, `${file}(fail) ${name}${why === undefined ? "" : ` — ${why}`}`);
};

// A compiler's error names its place on the next lines (`--> src/x.rs:3:5`); a test's message does not, and waits for
// the `(fail)` line it belongs to.
const plainError: Reader = (line, step, index, place) => {
    const plain = PLAIN_ERROR.exec(line);
    if (plain === null) {
        return undefined;
    }
    const where = placeBelow(step, index, RUST_PLACE);
    if (where === undefined) {
        place.testError = plain[1];
        return undefined;
    }
    return tagged(place, `${line} --> ${where}`);
};

const failedCheck: Reader = (line, step, index) => {
    const check = CHECK_FAILED.exec(line);
    return check === null ? undefined : `✗ ${check[1]}${findingsUnder(step, index).map((finding) => `\n- ${finding}`).join("")}`;
};

const lintError: Reader = (line, step, index, place) => {
    const lint = LINT_ERROR.exec(line);
    if (lint === null) {
        return undefined;
    }
    const where = placeBelow(step, index, LINT_PLACE);
    return tagged(place, `${lint[1]}${where === undefined ? "" : ` at ${where}`}`);
};

const READERS: readonly Reader[] = [
    matching(TS_ERROR, (match, place) => tagged(place, match.input)),
    testFailure,
    plainError,
    matching(RUSTFMT, (match) => `rustfmt: ${match[1]} differs at line ${match[2]}`),
    matching(CARGO_TEST, (match, place) => tagged(place, `test ${match[1]} FAILED`)),
    failedCheck,
    matching(TURBO_FAILED, (match) => `turbo: failed ${match[1]}`),
    matching(PNPM_ERROR, (match) => match[0]),
    matching(PLAYWRIGHT_FAIL, (match, place) => tagged(place, match[0].trim())),
    matching(JEST_FAIL, (match, place) => tagged(place, match[0].trim())),
    lintError,
];

const firstSaid = (line: string, step: readonly string[], index: number, place: Place): string | undefined => {
    for (const read of READERS) {
        const said = read(line, step, index, place);
        if (said !== undefined) {
            return said;
        }
    }
    return undefined;
};

// A step that failed in none of the shapes above still says something near its end.
const genericErrors = (step: readonly string[]): string[] =>
    step
        .slice(-GENERIC_WINDOW)
        .filter((line) => !ANY_ERROR_MARK.test(line) && GENERIC_ERROR.test(line))
        .slice(-GENERIC_KEPT);

// The errors one failed step printed, as lines a reader can act on, each tagged with the task it came from.
const stepErrors = (step: readonly string[]): string[] => {
    const place: Place = { task: undefined, file: undefined, testError: undefined, failed: new Set() };
    const found: string[] = [];
    step.forEach((raw, index) => {
        if (placeMarker(raw, place)) {
            return;
        }
        const line = unprefixed(raw, place);
        // A test that passed (or was skipped) settles whatever message came before it, and its name is no error even
        // when it quotes one.
        if (TEST_SETTLED.test(line)) {
            place.testError = undefined;
            return;
        }
        const said = firstSaid(line, step, index, place);
        if (said !== undefined) {
            found.push(said);
        }
    });
    return found.length > 0 ? found : genericErrors(step);
};

// An error as it is listed: each of its lines normalized, a check's findings indented under it.
const normalizedError = (error: string): string =>
    error
        .split("\n")
        .map((line, index) => (index === 0 ? normalizeErrorLine(line) : `    ${normalizeErrorLine(line)}`))
        .join("\n");

/** What is kept of one failed job: the errors its failed steps printed, once each, and those steps' last lines. */
export const excerptOf = (job: FailedJobLog): JobExcerpt => {
    const steps = failedSteps(linesOf(job.log));
    const errors = [...new Set(steps.flatMap(stepErrors).map(normalizedError))].slice(0, ERRORS_PER_JOB);
    const tail = lastBytes(steps.flatMap(stepText).join("\n").trim(), TAIL_KEPT);
    return { name: job.name, url: job.url, steps: [...job.steps], errors, tail };
};

const stepList = (steps: readonly string[]): string => (steps.length === 0 ? "" : `: ${steps.map((step) => `"${clip(step, STEP_NAME_MAX)}"`).join(", ")}`);

// Each error once, with every job that printed it, in the order they were first seen, within its share of the digest.
const errorList = (excerpts: readonly JobExcerpt[], maxBytes: number): string => {
    const jobsByError = new Map<string, string[]>();
    for (const job of excerpts) {
        for (const error of job.errors) {
            jobsByError.set(error, [...(jobsByError.get(error) ?? []), job.name]);
        }
    }
    if (jobsByError.size === 0) {
        return "No line in the failed steps read as an error; their last lines are below.";
    }
    const lines: string[] = [];
    let bytes = 0;
    let dropped = 0;
    for (const [error, jobs] of jobsByError) {
        const line = `- [${jobs.join(", ")}] ${error}`;
        if (bytes + line.length + 1 > maxBytes) {
            dropped += 1;
            continue;
        }
        lines.push(line);
        bytes += line.length + 1;
    }
    return ["Errors, each once, with every job that printed it:", ...lines, ...(dropped === 0 ? [] : [`… and ${dropped} more, in the jobs' logs`])].join(
        "\n",
    );
};

/** One run's failed jobs as the fix agent reads them: which jobs and steps, every error once with the jobs that printed
 *  it, then each failed step's last lines, all within `maxBytes`. */
export const digestOf = (excerpts: readonly JobExcerpt[], maxBytes = DIGEST_BYTES): string => {
    if (excerpts.length === 0) {
        return "";
    }
    const header = [
        `${excerpts.length} failed job${excerpts.length === 1 ? "" : "s"}:`,
        ...excerpts.map((job) => `- ${job.name}${stepList(job.steps)}${job.url === undefined ? "" : ` (${job.url})`}`),
    ].join("\n");
    const errors = errorList(excerpts, Math.floor(maxBytes * ERRORS_SHARE));
    // What is left is split evenly, so the last job heard is not the one whose words are cut away. The hundred bytes
    // each are its heading.
    const share = Math.max(0, Math.floor((maxBytes - header.length - errors.length) / excerpts.length) - 100);
    const tails = excerpts.map((job) => `--- ${job.name}: the failed steps' last lines ---\n${share === 0 ? "…" : lastBytes(job.tail, share)}`);
    return [header, errors, ...tails].join("\n\n");
};
