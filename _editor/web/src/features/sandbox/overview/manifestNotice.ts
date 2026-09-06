import type { ManifestProblem, ManifestProblemReport } from "@intentic/sandbox-contract";

/* WHAT A BROKEN SETTINGS FILE LOOKS LIKE ON A SCREEN, as data, so the card is a list and not an essay.
 *
 * The daemon reports a file and everything currently wrong with it (store/manifest-problems.ts). That is the
 * right shape to SEND and the wrong shape to read out loud, which is what the card used to do: a paragraph
 * establishing that settings files exist and get read, then the path, then one sentence per problem that
 * carried the diagnosis, the cause and two instructions in a single run-on. Six lines of prose for one
 * misspelled key, and the reader's actual questions, WHICH FILE, HOW BAD, WHAT DO I DO, were answered in that
 * order nowhere.
 *
 * THE ANSWER IS A LINE PER FILE AND NOTHING ELSE ON SCREEN. `file` and `impact` are the whole collapsed row —
 * two or three words — and everything else here is what the card shows only once somebody opens that row. A
 * notice nobody has opened yet is a list of names, which is the amount of attention an advisory about a config
 * file has actually earned.
 *
 *   `file`   the name alone (`settings.json`). All of these live in one directory (REPORTED_MANIFEST_PATHS),
 *            so repeating `.intentic/config/` down a column is three words of chrome per row that distinguish
 *            nothing. The full `path` is still what gets opened, and what a hover reports.
 *   `impact` how much of it stopped applying, as a tag the eye can sort a list by without reading it.
 *   `lines`  one line per problem, self-contained, no shared preamble to carry down the list.
 *   `fix`    the action, on its own, and only when there is one worth printing.
 *
 * The wording lives here rather than in the template because it is the part with rules (plurals, a quoted key,
 * a suggestion that may be absent) and rules in a template are rules nothing tests. */

export interface ManifestNotice {
    // Workspace-relative, exactly as the daemon reported it: what a click opens and what a hover shows.
    readonly path: string;
    // The last segment of it, which is what the row is titled with. See the note above.
    readonly file: string;
    // How much of the file stopped applying. A tag, not a count of complaints: "3 problems" tells a reader
    // nothing they can act on, where "using defaults" tells them the whole file is currently doing nothing.
    readonly impact: string;
    // Shown only inside an opened row: the collapsed list is names and tags.
    readonly lines: readonly string[];
    /* THE ONE INSTRUCTION, absent when the lines already carry it. A suggested spelling IS the instruction
     * ("did you mean skills?"), and printing "correct the file" under it is a line that adds a line. */
    readonly fix?: string;
}

/* Fragments arrive from the daemon written to be embedded ("the file is not valid JSON"), and are shown here
 * standing on their own. Capitalised and stopped once, in one place: the old card interpolated them mid-sentence
 * and ended up printing "…is actually wrong.. Every setting…", which is the punctuation equivalent of a typo in
 * a warning about typos. */
const sentence = (text: string): string => {
    const trimmed = text.trim();
    if (trimmed === ``) {
        return trimmed;
    }
    const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// How much of the file is currently not applying, in the reader's terms rather than the parser's. Unreadable
// outranks everything: a file being ignored whole is not "1 problem", it is every setting in it gone.
const impactOf = (problems: readonly ManifestProblem[]): string => {
    if (problems.some((problem) => problem.kind === `unreadable`)) {
        return `using defaults`;
    }
    if (problems.every((problem) => problem.kind === `unknownKey`)) {
        return `${count(problems.length, `setting`, `settings`)} ignored`;
    }
    if (problems.every((problem) => problem.kind === `invalidEntry`)) {
        return `${count(problems.length, `entry`, `entries`)} skipped`;
    }
    return count(problems.length, `problem`, `problems`);
};

/* One line, saying the part the ROW does not already say. The tag above it has stated the damage ("2 settings
 * ignored"), so restating it per line — "isn't a setting this sandbox knows, so it's ignored" — is a sentence
 * spent on something the reader has read. What is left is the specific: which key, and what it was probably
 * meant to be. The key is quoted because it is a string they are about to search the file for; the suggestion
 * is a question, not an assertion, because the daemon guessed it and a confident wrong guess sends someone to
 * edit a line that was never the problem. */
const lineOf = (problem: ManifestProblem): string => {
    if (problem.kind === `unknownKey`) {
        return problem.suggestion === undefined
            ? `"${problem.detail}" — no setting by that name.`
            : `"${problem.detail}" — did you mean "${problem.suggestion}"?`;
    }
    return sentence(problem.detail);
};

/* WHAT TO DO, taken from the daemon when it knows something the browser cannot work out, and otherwise said
 * once here. The skew case is the whole reason the wire carries a `fix` at all: "update the sandbox, the file
 * is probably fine" is the opposite of the advice every other unreadable file gets, and getting it wrong costs
 * someone a config they hand-edited into matching an older build. */
const fixOf = (problems: readonly ManifestProblem[]): string | undefined => {
    const told = problems.find((problem) => problem.fix !== undefined)?.fix;
    if (told !== undefined) {
        return told;
    }
    return problems.some((problem) => problem.kind === `unreadable`) ? `Fix the file and it applies again.` : undefined;
};

export const manifestNotices = (reports: readonly ManifestProblemReport[]): ManifestNotice[] =>
    reports.map(({ path, problems }) => {
        const fix = fixOf(problems);
        return {
            path,
            // Split on `/` alone: these paths come off the wire workspace-relative and normalised, never as
            // Windows paths (the daemon relativises before it reports).
            file: path.split(`/`).at(-1) ?? path,
            impact: impactOf(problems),
            lines: problems.map(lineOf),
            ...(fix === undefined ? {} : { fix }),
        };
    });
