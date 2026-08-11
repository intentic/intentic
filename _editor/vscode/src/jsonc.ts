/* Theme documents are JSONC — comments and trailing commas are common in shipped themes — and the editor's
 * own parser isn't part of the extension API. This is the minimal tolerant read: strip comments outside
 * strings, drop trailing commas, then JSON.parse. PURE, so the odd corners (a `//` inside a color string, an
 * escaped quote before a comment) are pinned by tests rather than discovered per theme. */
export const jsoncParse = (text: string): unknown => {
    let out = "";
    let inString = false;
    let index = 0;
    while (index < text.length) {
        const char = text[index] as string;
        if (inString) {
            out += char;
            if (char === "\\") {
                out += text[index + 1] ?? "";
                index += 2;
                continue;
            }
            if (char === `"`) {
                inString = false;
            }
            index += 1;
            continue;
        }
        if (char === `"`) {
            inString = true;
            out += char;
            index += 1;
            continue;
        }
        if (char === "/" && text[index + 1] === "/") {
            while (index < text.length && text[index] !== "\n") {
                index += 1;
            }
            continue;
        }
        if (char === "/" && text[index + 1] === "*") {
            index += 2;
            while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
                index += 1;
            }
            index += 2;
            continue;
        }
        out += char;
        index += 1;
    }
    // Trailing commas: `,` directly before a closing brace/bracket (whitespace between allowed).
    return JSON.parse(out.replace(/,\s*([}\]])/g, "$1"));
};
