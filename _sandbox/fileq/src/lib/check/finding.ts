// What `fileq check` reports, and the rules every format shares.
// An ERROR is a fact read off the file's structure that a reader will meet: a missing image, a formula showing #REF!,
// a link to a bookmark that is not there. A WARNING is either a fact whose harm depends on the reader (a tracked change,
// an empty placeholder) or an estimate (text overflowing its box, measured with average glyph widths, not the font).
// An estimate is never an error: the exit code must be something an agent can act on without second-guessing it.

export type Severity = "error" | "warning";

export interface Finding {
    readonly severity: Severity;
    /** A stable name for the rule, for grouping and for --json readers (`missing-image`, `formula-error`). */
    readonly rule: string;
    /** Where it is, in the reader's units: `slide 3 · "Title 1"`, `Sheet1!B4`, `page 7`; empty for the whole file. */
    readonly where: string;
    readonly message: string;
}

export interface CheckReport {
    readonly format: string;
    /** The document's size in its own units (`12 slides`, `3 sheets`, `8 pages`); undefined when it could not be read. */
    readonly extent?: string | undefined;
    readonly findings: Finding[];
    /** What was not checked and why (a part too large, a cap reached). */
    readonly notes: string[];
}

export const error = (rule: string, where: string, message: string): Finding => ({ severity: "error", rule, where, message });
export const warning = (rule: string, where: string, message: string): Finding => ({ severity: "warning", rule, where, message });

export const plural = (count: number, noun: string, nouns = `${noun}s`): string => `${count} ${count === 1 ? noun : nouns}`;

/** A text excerpt for a message: one line, quoted, cut at `max` characters. */
export const excerpt = (text: string, max = 60): string => {
    const line = text.replaceAll(/\s+/g, " ").trim();
    return `"${line.length > max ? `${line.slice(0, max - 1)}…` : line}"`;
};

// Text an authoring tool or a template put there for a person to replace. The first group is never a document's own
// words: Office's placeholder prompts and filler Latin. The second usually is not, but a schedule can say TBD.
const LEFTOVER_CERTAIN: readonly RegExp[] = [
    /\bClick (?:or tap )?(?:here )?(?:to|icon to) (?:add|edit|enter|insert)\b[^.\n]*/i,
    /\bLorem ipsum\b/i,
    /\bError! (?:Reference source not found|Bookmark not defined|No table of contents entries found|Not a valid)[^.\n]*/,
];
const LEFTOVER_LIKELY: readonly RegExp[] = [/\b(?:TODO|FIXME|TBD|XXX)\b/, /\{\{[^{}\n]{1,40}\}\}/, /\[(?:insert|add|your|placeholder)\b[^\]\n]{0,40}\]/i];

/** Leftover template or editor text in `text`, as findings at `where`; at most one per rule, the first match quoted. */
export const leftoverText = (text: string, where: string): Finding[] => {
    const certain = LEFTOVER_CERTAIN.map((pattern) => pattern.exec(text)?.[0]).find((match) => match !== undefined);
    if (certain !== undefined) {
        return [error("leftover-text", where, `leftover template text ${excerpt(certain)}: replace it with the real content or delete it`)];
    }
    const likely = LEFTOVER_LIKELY.map((pattern) => pattern.exec(text)?.[0]).find((match) => match !== undefined);
    if (likely !== undefined) {
        return [warning("leftover-text", where, `looks like a note left for later: ${excerpt(likely)}`)];
    }
    return [];
};

const EMU_PER_INCH = 914_400;

/** EMUs as inches for a message: `1.5 in`. */
export const inches = (emu: number): string => `${Number((emu / EMU_PER_INCH).toFixed(2))} in`;
