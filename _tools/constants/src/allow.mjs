// THE TWO WAYS TO SAY A CHECK'S FINDING IS RIGHT HERE, read the same way by every check and suite that honours them.
//
// - A SITE PRAGMA, `// allow(<check>): <reason>`, for one place in the code: on the flagged line, or anywhere in the
//   comment block directly above it. Markup spells it `<!-- allow(<check>): <reason> -->`. It lives on the declaration
//   it excuses, so a rename carries it and a deletion takes it away, which a list of names kept somewhere else cannot do.
// - A COMMIT TRAILER, `Allow: <check> — <reason>`, for a change: what the range adds to that check is accepted, with the
//   reason in the history. `—`, `–`, `-` or `:` may separate the two.
//
// A reason is required in both: an exception nobody can explain is a finding nobody fixed.

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// Comment openers the pragma may follow: a line comment, a block comment or one of its continuation lines, markup's, or
// JSX's `{/*`.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|<!--|\{\/\*)/;
// The last line of a markup comment that began on an earlier one.
const MARKUP_TAIL = /^(?!.*<!--).*-->\s*$/;

// A pragma's comment opener, and the closer its comment may end with, which is never its reason.
const OPENER = String.raw`(?:\/\/|\/\*|\*|<!--)`;
const CLOSER = String.raw`(?:\*\/\}?|-->)`;

/** The reason a pragma for `check` in `text` gives, or undefined when `text` holds none with a reason. */
export const pragmaReason = (text, check) => {
    const found = new RegExp(String.raw`${OPENER}\s*allow\(${escape(check)}\):\s*(?!${CLOSER})(\S[^\n]*?)\s*${CLOSER}?\s*$`, "m").exec(text);
    return found?.[1];
};

/**
 * The 1-based line of the pragma for `check` that excuses the site on 1-based `line` of `lines`: the line itself, or one
 * in the comment block that ends on the line above it. Undefined when none does.
 */
export const allowingLine = (lines, line, check) => {
    const says = (text) => pragmaReason(text, check) !== undefined;
    if (says(lines[line - 1] ?? "")) {
        return line;
    }
    // Inside a markup comment read upwards from its tail, every line is comment until the one that opens it.
    let inMarkup = false;
    for (let at = line - 2; at >= 0; at--) {
        const text = lines[at];
        const tail = MARKUP_TAIL.test(text);
        if (!inMarkup && !tail && !COMMENT_LINE.test(text)) {
            return undefined;
        }
        if (says(text)) {
            return at + 1;
        }
        inMarkup = tail || (inMarkup && !text.includes("<!--"));
    }
    return undefined;
};

/** Whether the site on 1-based `line` of `lines` carries a pragma for `check` (`allowingLine`). */
export const allowedAt = (lines, line, check) => allowingLine(lines, line, check) !== undefined;

const TRAILER = /^Allow:[ \t]*([\w./-]+?)[ \t]*(?:—|–|:|-{1,2})[ \t]*(\S.*?)[ \t]*$/gm;

/** Every `Allow: <check> — <reason>` line in a commit message or a trailer listing, in order. */
export const allowTrailers = (text) => [...text.matchAll(TRAILER)].map(([, check, reason]) => ({ check, reason }));
