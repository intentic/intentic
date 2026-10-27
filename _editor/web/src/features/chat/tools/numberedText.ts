// A file's lines as a tool printed them with their numbers in front (Read's `  12→`, `cat -n`'s and `nl`'s `  12<tab>`),
// taken apart into the code and the number its first line had, so a card can draw its own gutter.

// Strips the SDK's numbered gutter (`<n><arrow-or-tab><content>`) into bare code plus the first line's number;
// undefined unless the numbers form a strict +1 run over most lines.
const NUMBERED_LINE = /^ *(\d+)(?:→|\t)(.*)$/;
export const numberedFileBody = (text: string): { readonly code: string; readonly firstLine: number } | undefined => {
    const lines = text.split(`\n`);
    const code: string[] = [];
    let firstLine: number | undefined;
    let next = 0;
    let matched = 0;
    for (const line of lines) {
        const parsed = NUMBERED_LINE.exec(line);
        if (parsed === null) {
            if (firstLine === undefined) {
                return undefined; // First line isn't numbered: not a file view.
            }
            code.push(line); // Trailing marker or blank line after an established run.
            continue;
        }
        const n = Number(parsed[1]);
        if (firstLine === undefined) {
            firstLine = n;
        } else if (n !== next) {
            return undefined; // Break in the +1 sequence: arbitrary numeric text, not a file view.
        }
        next = n + 1;
        matched += 1;
        code.push(parsed[2] ?? ``);
    }
    // Numbered run must be a clear majority, so a few coincidentally-numbered prose lines don't count as a file.
    if (firstLine === undefined || matched * 2 < lines.length) {
        return undefined;
    }
    return { code: code.join(`\n`), firstLine };
};
