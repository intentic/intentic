// The daemon's turn preamble as a reader outside the sandbox sees it. The daemon puts notes (the project map, the checks
// note, retrieved context…) in front of what the user typed, and they end at the FIRST separator; the notes and the
// exact header list stay in the sandbox (agent/prompt/turn-preamble.ts). Session recall reads provider transcripts
// written that way and cannot depend on the sandbox, so it recognises a preamble by its opening and a drift test there
// holds every header the daemon parses to this recogniser.

export const TURN_PREAMBLE_SEPARATOR = "\n\n---\n\n";

// The two notes that open without a markdown heading: the dependency notices. Every other note opens "## ".
export const SETUP_NOTICE_HEADER =
    "Dependencies are NOT installed for the following projects, so their type-checks, linters and tests cannot work yet";
export const STALE_NOTICE_HEADER = "Some dependencies declared under /work are not installed";

// Wider than the daemon's own list on purpose: transcripts keep notes the daemon has since retired ("## Your branch
// moved onto newer main"), and those must come off too.
export const opensWithInjectedNote = (text: string): boolean =>
    text.startsWith("## ") || text.startsWith(SETUP_NOTICE_HEADER) || text.startsWith(STALE_NOTICE_HEADER);

// The user's own words with the preamble taken off: cut at the FIRST separator, as the daemon's own parser cuts, and
// only when the text opens like a note. A note-like opening with no separator, or any other opening, leaves the text
// whole rather than cut at a guess.
export const stripInjectedPreamble = (text: string): string => {
    if (!opensWithInjectedNote(text)) {
        return text;
    }
    const separator = text.indexOf(TURN_PREAMBLE_SEPARATOR);
    return separator === -1 ? text : text.slice(separator + TURN_PREAMBLE_SEPARATOR.length);
};
