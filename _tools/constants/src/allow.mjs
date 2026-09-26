// THE TWO WAYS TO SAY A CHECK'S FINDING IS RIGHT HERE, read the same way by every check and suite that honours them.
//
// - A SITE PRAGMA, `// allow(<check>): <reason>`, for one place in the code: on the flagged line, or anywhere in the
//   comment block directly above it. It lives on the declaration it excuses, so a rename carries it and a deletion
//   takes it away, which a list of names kept somewhere else cannot do.
// - A COMMIT TRAILER, `Allow: <check> — <reason>`, for a change: what the range adds to that check is accepted, with the
//   reason in the history. `—`, `–`, `-` or `:` may separate the two.
//
// A reason is required in both: an exception nobody can explain is a finding nobody fixed.

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

// Comment openers the pragma may follow: a line comment, a block comment or one of its continuation lines.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** The reason a pragma for `check` in `text` gives, or undefined when `text` holds none with a reason. */
export const pragmaReason = (text, check) => {
    const found = new RegExp(String.raw`(?:\/\/|\/\*|\*)\s*allow\(${escape(check)}\):\s*(\S[^\n]*?)\s*(?:\*\/)?\s*$`, "m").exec(text);
    return found?.[1];
};

/**
 * Whether the site on 1-based `line` of `lines` carries a pragma for `check`: on the line itself, or in the comment block
 * that ends on the line above it.
 */
export const allowedAt = (lines, line, check) => {
    const says = (text) => pragmaReason(text, check) !== undefined;
    if (says(lines[line - 1] ?? "")) {
        return true;
    }
    for (let at = line - 2; at >= 0 && COMMENT_LINE.test(lines[at]); at--) {
        if (says(lines[at])) {
            return true;
        }
    }
    return false;
};

const TRAILER = /^Allow:[ \t]*([\w./-]+?)[ \t]*(?:—|–|:|-{1,2})[ \t]*(\S.*?)[ \t]*$/gm;

/** Every `Allow: <check> — <reason>` line in a commit message or a trailer listing, in order. */
export const allowTrailers = (text) => [...text.matchAll(TRAILER)].map(([, check, reason]) => ({ check, reason }));
