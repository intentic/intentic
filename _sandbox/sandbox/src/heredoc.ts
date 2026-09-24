// Where a shell command line's heredoc bodies sit, for every reader that must treat them as data, not commands.

// A heredoc's opening `<<WORD`.
const HEREDOC_START = /<<-?\s*(["']?)([A-Za-z_][\w]*)\1/g;

// The [start, end) spans of every heredoc body in the command, in order.
export const heredocSpans = (command: string): { start: number; end: number }[] => {
    const spans: { start: number; end: number }[] = [];
    for (const match of command.matchAll(HEREDOC_START)) {
        const word = match[2];
        if (word === undefined) {
            continue;
        }
        // Body: line after the delimiter to the line holding the word alone; unterminated protects the rest.
        const bodyStart = command.indexOf("\n", match.index + match[0].length);
        if (bodyStart === -1) {
            continue;
        }
        const terminator = new RegExp(String.raw`^[ \t]*${word}[ \t]*$`, "m");
        const rest = terminator.exec(command.slice(bodyStart));
        spans.push({ start: bodyStart, end: rest === null ? command.length : bodyStart + rest.index });
    }
    return spans;
};
