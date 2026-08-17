/* READING `openclaw.json` WITHOUT A JSON5 DEPENDENCY. The file is machine-written plain JSON until a person
 * edits it, and what people actually add is what JSON5 invites: comments, trailing commas, the odd single-
 * quoted string. This walk removes exactly those — character by character, tracking strings, so a `//` inside
 * a URL value or a `,]` inside a quoted string is never touched — and hands the rest to JSON.parse.
 *
 * Deliberately NOT a JSON5 parser: hex numbers, `+`/leading-dot numbers and line continuations fail here, and
 * that is a degradation the migration already knows how to word (the config is refused BY NAME and the file
 * items still import). A full parser is one small dependency away the day a real archive defeats this. */

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
        // Strings: copied verbatim (double) or re-quoted (single), with escapes honored so a closing quote
        // inside one can never end it early.
        if (char === `"` || char === `'`) {
            const quote = char;
            let body = "";
            index += 1;
            while (index < raw.length && raw[index] !== quote) {
                if (raw[index] === "\\") {
                    const next = raw[index + 1] ?? "";
                    // A JSON5 `\'` has no meaning in JSON — unescape it; everything else passes through.
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
        /* A bare identifier: quoted when a colon follows (an unquoted KEY, the JSON5 idiom people reach for
         * first), passed through otherwise (true/false/null in value position — the only bare words JSON5
         * itself allows there). */
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

/* Trailing commas, dropped in a SECOND pass over the comment-free text — in the first pass the lookahead from
 * a comma could land on a comment that hides the closing bracket, and the comma survived. Here every string is
 * already double-quoted, so a comma inside one is skipped by the same string-tracking the first pass does. */
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
