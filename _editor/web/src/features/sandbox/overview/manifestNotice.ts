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
 *   `lines`  one line per problem, self-contained, no shared preamble to carry down the list — each carrying
 *            the button that ends it, when it is a problem that can be ended by a button.
 *   `fix`    the action, on its own, and only when there is one worth printing.
 *
 * The wording lives here rather than in the template because it is the part with rules (plurals, a quoted key,
 * a suggestion that may be absent) and rules in a template are rules nothing tests.
 *
 * WHICH LINES GET A BUTTON, AND WHY IT IS ONLY THE ONE. A stray key is the single problem here whose remedy is
 * fully determined by what has already been printed: the daemon named the key, and often the name it meant. So
 * the line that says "did you mean skills?" ends with the click that means it — anything else is asking the
 * reader to go and retype what the sandbox has already worked out. The other two kinds get no button, and the
 * refusals are not oversights:
 *
 *   • an UNREADABLE file has bytes somebody has to look at, and in the version-skew case the file is probably
 *     RIGHT, so the remedy points at the sandbox rather than the file. `fix` already says which; the update
 *     card that performs it is on this same screen, and a second update button buried in a settings notice
 *     would be the third place that flow lives.
 *   • an INVALID ENTRY could only be dropped, which deletes a capability or persona somebody wrote. A stray
 *     key does nothing before or after being removed; a skipped entry is configuration they meant to have.
 *     Different risk class, so it gets the file opened instead of a one-click delete. */

/* A REPAIR THE APP PERFORMS ITSELF, as the two values the route takes (schemas/system.ts) plus the words on
 * the button. `to` absent is a removal; present is a rename that carries the value across.
 *
 * TWO LABELS, AND THE SHORT ONE IS THE POINT. The button sits at the end of the sentence that explains it, so
 * the sentence is its subject: after `"skils" — did you mean "skills"?`, a button reading `Rename it` is
 * unambiguous and one reading `Rename to "skills"` repeats a word the reader passed two words ago. That
 * repetition is not only redundant, it is WIDE — a long key made a 180px button, and three problems in one
 * file drew three buttons at three different distances from the left, a staircase of controls the eye has to
 * re-find on every line. Short labels put them in nearly a column.
 *
 * `spoken` is the same action with its subject restored, for the reader who arrives at the button WITHOUT the
 * sentence: a screen reader on a button-by-button pass, and a hover on a line somebody has scrolled to. Short
 * for the eye, complete for everything else — the alternative is choosing which of those two readers to fail. */
export interface ManifestRepairAction {
    readonly key: string;
    readonly to?: string;
    readonly label: string;
    readonly spoken: string;
}

export interface ManifestLine {
    readonly text: string;
    /* Empty for every problem but a stray key, which is the one a button can end (see the note above).
     *
     * A LIST BECAUSE THE GUESS CAN BE WRONG. "did you mean skills?" has two answers worth one click each: yes,
     * and no — that key is junk, take it out. Offering only the rename would make a conservative guess
     * (nearestKey) into the app's opinion about what somebody meant to type, and leave the reader who knows
     * better with nothing but the file. The order is the answer-to-the-question first. */
    readonly repairs: readonly ManifestRepairAction[];
}

export interface ManifestNotice {
    // Workspace-relative, exactly as the daemon reported it: what a click opens and what a hover shows.
    readonly path: string;
    // The last segment of it, which is what the row is titled with. See the note above.
    readonly file: string;
    // How much of the file stopped applying. A tag, not a count of complaints: "3 problems" tells a reader
    // nothing they can act on, where "using defaults" tells them the whole file is currently doing nothing.
    readonly impact: string;
    // Shown only inside an opened row: the collapsed list is names and tags.
    readonly lines: readonly ManifestLine[];
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
const lineOf = (problem: ManifestProblem): ManifestLine => {
    if (problem.kind === `unknownKey`) {
        /* THE BUTTONS ARE THE END OF THE SENTENCE. `Remove it` under "no setting by that name", `Rename to
         * "skills"` under "did you mean?": each answers the question its own line asked, which is what lets
         * them live on a row without a heading explaining what the buttons are for.
         *
         * The rename stays a QUESTION above and an offer below, never a done deal. `nearestKey` is deliberately
         * conservative but it is still a guess, and one click is the right price for a guess — as against
         * applying it, which would be the app deciding what somebody meant to type. */
        const remove = { key: problem.detail, label: `Remove it`, spoken: `Remove "${problem.detail}"` };
        return problem.suggestion === undefined
            ? { text: `"${problem.detail}" — no setting by that name.`, repairs: [remove] }
            : {
                  text: `"${problem.detail}" — did you mean "${problem.suggestion}"?`,
                  repairs: [
                      {
                          key: problem.detail,
                          to: problem.suggestion,
                          label: `Rename it`,
                          spoken: `Rename "${problem.detail}" to "${problem.suggestion}"`,
                      },
                      remove,
                  ],
              };
    }
    return { text: sentence(problem.detail), repairs: [] };
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
