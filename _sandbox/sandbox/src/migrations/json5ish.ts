// Tolerant reader for `openclaw.json`, hand-written JSON5-ish edits (comments, trailing commas, single quotes) over
// plain JSON, string-tracking so none of that logic touches text inside a real string. Not a full JSON5 parser:
// hex/leading-dot numbers and continuations fail, degrading to a named refusal rather than losing the whole import.

export const parseJson5ish = (raw: string): unknown | undefined => {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        // Fall through to the tolerant pass.
    }
    let out = "";
    let index = 0;
    while (index < raw.length) {
        const char = raw[index] ?? "";
        // Strings: copied verbatim (double-quoted) or re-quoted (single); escapes honored so a quote inside can't end
        // it early.
        if (char === `"` || char === `'`) {
            const quote = char;
            let body = "";
            index += 1;
            while (index < raw.length && raw[index] !== quote) {
                if (raw[index] === "\\") {
                    const next = raw[index + 1] ?? "";
                    // A JSON5 `\'` has no meaning in JSON, unescape it; everything else passes through.
                    body += next === "'" ? "'" : `\\${next}`;
                    index += 2;
                    continue;
                }
                body += raw[index];
                index += 1;
            }
            index += 1; // the closing quote
            out += quote === `'` ? `"${body.replaceAll(`"`, `\\"`)}"` : `"${body}"`;
            continue;
        }
        if (char === "/" && raw[index + 1] === "/") {
            while (index < raw.length && raw[index] !== "\n") {
                index += 1;
            }
            continue;
        }
        if (char === "/" && raw[index + 1] === "*") {
            index += 2;
            while (index < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
                index += 1;
            }
            index += 2;
            continue;
        }
        // Bare identifier: quoted when a colon follows (an unquoted key); passed through otherwise (true/false/null in
        // value position).
        if (/[A-Za-z_$]/.test(char)) {
            let ident = "";
            while (index < raw.length && /[A-Za-z0-9_$]/.test(raw[index] ?? "")) {
                ident += raw[index];
                index += 1;
            }
            let ahead = index;
            while (ahead < raw.length && /\s/.test(raw[ahead] ?? "")) {
                ahead += 1;
            }
            out += raw[ahead] === ":" ? `"${ident}"` : ident;
            continue;
        }
        out += char;
        index += 1;
    }
    try {
        return JSON.parse(dropTrailingCommas(out)) as unknown;
    } catch {
        return undefined;
    }
};

// Trailing commas are dropped in a second pass, after comments are gone: in the first pass, a comma's lookahead could
// land on a comment hiding the closing bracket. Strings here are already double-quoted, so tracking them is simple.
const dropTrailingCommas = (cleaned: string): string => {
    let out = "";
    let index = 0;
    while (index < cleaned.length) {
        const char = cleaned[index] ?? "";
        if (char === `"`) {
            out += char;
            index += 1;
            while (index < cleaned.length && cleaned[index] !== `"`) {
                if (cleaned[index] === "\\") {
                    out += cleaned[index] ?? "";
                    index += 1;
                }
                out += cleaned[index] ?? "";
                index += 1;
            }
            out += cleaned[index] ?? "";
            index += 1;
            continue;
        }
        if (char === ",") {
            let ahead = index + 1;
            while (ahead < cleaned.length && /\s/.test(cleaned[ahead] ?? "")) {
                ahead += 1;
            }
            if (cleaned[ahead] === "}" || cleaned[ahead] === "]") {
                index += 1;
                continue;
            }
        }
        out += char;
        index += 1;
    }
    return out;
};
