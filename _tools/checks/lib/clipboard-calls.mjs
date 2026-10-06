// What clipboard-tiers.mjs reads a file for: every place it reaches the browser's clipboard directly instead of through
// the kit, by shape, since the checks run before install. Kept apart from the check so its suite can feed it text.
import { allowedAt } from "./allow.mjs";

// `navigator.clipboard`, optional-chained or not, and on another window's navigator too (`view.navigator.clipboard`).
const DIRECT = /\bnavigator\??\.clipboard\b/;

// Prose is not a call site: the comments this repo writes quote the very shape it bans.
const COMMENT = /^\s*(?:\/\/|\*|\/\*|<!--)/;

/** Every direct clipboard reach in `text`, as `{ line, why }`, less the ones a `// allow(clipboard-tiers): <reason>` excuses. */
export const clipboardCalls = (text) => {
    const lines = text.split(`\n`);
    const found = [];
    for (const [index, line] of lines.entries()) {
        if (!COMMENT.test(line) && DIRECT.test(line)) {
            found.push({ line: index + 1, why: `navigator.clipboard belongs to this realm's document, which a popped-out window's press does not focus` });
        }
    }
    return found.filter(({ line }) => !allowedAt(lines, line, `clipboard-tiers`));
};
