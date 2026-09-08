import type { ManifestProblem, ManifestProblemReport } from "@intentic/sandbox-contract";

// Render-ready shape for a broken settings file: `file`/`impact` are the whole collapsed row; everything else
// shows only once opened. Only an unknownKey problem gets a repair button, its remedy already fully known; an
// unreadable file points at the update card, and an invalid entry can only be dropped by hand.

// Mirrors the repair route's two inputs (schemas/system.ts); `to` absent is a removal, present a rename. Labels
// stay short since the button follows a sentence naming the key; `spoken` restores that for a screen reader or hover.
export interface ManifestRepairAction {
    readonly key: string;
    readonly to?: string;
    readonly label: string;
    readonly spoken: string;
}

export interface ManifestLine {
    readonly text: string;
    // A rename is offered beside the removal, never applied alone, since the suggested key could be wrong.
    readonly repairs: readonly ManifestRepairAction[];
}

export interface ManifestNotice {
    // Workspace-relative, exactly as the daemon reported it.
    readonly path: string;
    // Last path segment; what the row is titled with.
    readonly file: string;
    // A sortable-by-eye tag of how much stopped applying, not a complaint count.
    readonly impact: string;
    // Shown only once the row is opened; the collapsed row is just `file` and `impact`.
    readonly lines: readonly ManifestLine[];
    // The one instruction, omitted when a line already carries it (e.g. a suggested rename).
    readonly fix?: string;
}

// Daemon fragments are written to be embedded mid-sentence; this stands them alone, capitalised and ended
// exactly once.
const sentence = (text: string): string => {
    const trimmed = text.trim();
    if (trimmed === ``) {
        return trimmed;
    }
    const capitalised = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    return /[.!?]$/.test(capitalised) ? capitalised : `${capitalised}.`;
};

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// How much of the file is currently not applying, in the reader's terms, not the parser's. An unreadable file
// outranks any per-key count: the whole file is off, not "1 problem".
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

// States only what the tag above doesn't: which key, and what it was probably meant to be. Quoted since it's a
// string to search for; a suggestion is a question, since the guess could be wrong.
const lineOf = (problem: ManifestProblem): ManifestLine => {
    if (problem.kind === `unknownKey`) {
        // Buttons answer the question their own line asked, so they need no separate heading. A rename stays a question
        // until clicked: `nearestKey` guesses, so applying it silently would decide for the reader.
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

// The one thing to do, from the daemon when it knows something the browser can't (the skew case: update the
// sandbox, not the file), otherwise said once here.
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
            // Paths arrive workspace-relative and already normalised (forward slashes), never as Windows paths.
            file: path.split(`/`).at(-1) ?? path,
            impact: impactOf(problems),
            lines: problems.map(lineOf),
            ...(fix === undefined ? {} : { fix }),
        };
    });
