// HOW A REPORTED FINDING STAYS VISIBLE WITHOUT FAILING THE JOB. In CI, `--report` (run.mjs, verify-push.mjs) lets only
// the checks manifest.mjs lists in CI_BLOCKING fail; everything else a run finds is said here instead: a warning
// annotation on each line a finding names, which GitHub draws on the file in the run's page and in a pull request's
// diff, and a block in the job's step summary, which is the first thing the run's page shows. Outside GitHub Actions
// both are silent and the finding prints as it always did.
import { appendFileSync } from "node:fs";

// GitHub keeps 10 warning annotations per step and 50 per job, and drops the rest without saying so. One process here
// is one step, so past this many the rest are left to the summary, which says how many it holds.
export const ANNOTATION_LIMIT = 10;
// Lines of one finding block the summary carries before it says how many it left out.
const SUMMARY_LINES = 40;

const inActions = (env = process.env) => env.GITHUB_ACTIONS === "true";

// The workflow-command escapes from actions/toolkit's command.ts: data escapes `%`, CR and LF; a property also `:` and `,`.
const escapeData = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text) => escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

// A finding line as the checks print one: an optional list bullet, a repo-relative path with an extension, an optional
// `:line` and `:column`, then the message after a colon, two spaces or a dash. oxlint's `unix` format
// (`a.ts:12:5: message [Error/rule]`) reads the same way.
const FINDING = /^\s*(?:[-*•]\s+)?((?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.[A-Za-z0-9]+)(?::(\d+))?(?::(\d+))?(?::\s*|\s{2,}|\s[—–-]\s)(\S.*)$/u;

/** The file, line and message a finding line names, or undefined for a line that names no file. */
export const locate = (line) => {
    const found = FINDING.exec(line);
    if (found === null) {
        return undefined;
    }
    const [, file, row, column, message] = found;
    const located = { file, message: message.trim() };
    if (row !== undefined) {
        located.line = Number(row);
    }
    if (column !== undefined) {
        located.col = Number(column);
    }
    return located;
};

/** One `::warning` command for a located finding. */
export const annotation = (title, { file, line, col, message }) => {
    const properties = [`file=${escapeProperty(file)}`, ...(line === undefined ? [] : [`line=${line}`]), ...(col === undefined ? [] : [`col=${col}`]), `title=${escapeProperty(title)}`];
    return `::warning ${properties.join(",")}::${escapeData(message)}`;
};

/**
 * A reporter for one process: `annotate(title, lines)` turns every line that names a file into a warning annotation
 * (up to ANNOTATION_LIMIT for the whole process), and `summary(title, why, lines)` adds a block to the step summary.
 * Both write only inside GitHub Actions. `env` and `write` are the seams the tests use.
 */
export const createReporter = ({ env = process.env, write = (text) => process.stdout.write(text) } = {}) => {
    let annotated = 0;
    const live = inActions(env);
    const annotate = (title, lines) => {
        if (!live) {
            return 0;
        }
        let made = 0;
        for (const line of lines) {
            const found = locate(line);
            if (found === undefined || annotated >= ANNOTATION_LIMIT) {
                continue;
            }
            write(`${annotation(title, found)}\n`);
            annotated += 1;
            made += 1;
        }
        return made;
    };
    const summary = (title, why, lines = []) => {
        const file = env.GITHUB_STEP_SUMMARY;
        if (!live || file === undefined || file === "") {
            return;
        }
        const shown = lines.slice(0, SUMMARY_LINES);
        const left = lines.length - shown.length;
        const body = shown.length === 0 ? "" : `\n\`\`\`\n${shown.join("\n").replaceAll("```", "ʼʼʼ")}\n\`\`\`${left > 0 ? `\n…and ${left} more line(s) in the log` : ""}`;
        appendFileSync(file, `\n#### ${title}\n${why}${body}\n`);
    };
    return { annotate, summary, live };
};
