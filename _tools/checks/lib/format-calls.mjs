// What format-tiers.mjs reads a file for: every place it formats a number or a date by hand instead of through the
// kit, by shape, since the checks run before install. Kept apart from the check so its suite can feed it text.
import { allowedAt } from "./allow.mjs";

// The platform's own formatters. Each one reads the BROWSER's language (or a tag spelled at the site) rather than the
// app's, builds its formatter where it stands, and so stays in the language the page booted in after a switch.
const BY_HAND = [
    [/\.toLocale(?:Date|Time)?String\(/, (call) => `${call.slice(1, -1)}() reads the browser's language, not the app's`],
    [/new Intl\.(?:NumberFormat|DateTimeFormat)\(/, (call) => `${call.slice(4, -1)} built outside the kit stays in the language it was built in`],
    [/\bIntl\.RelativeTimeFormat\b/, () => `a relative time built outside the kit: timeAgo already says it in every language`],
];

// The base library's labels are English and fixed ("1.4 MB", "90s"): right for the daemon and the CLIs, which have no
// reader's language, and wrong on a screen that has one.
const BASE_IMPORT = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@intentic\/base(?:\/[\w-]+)?["']/g;
const BASE_LABELS = new Map([
    [`sizeLabel`, `formatBytes`],
    [`briefDuration`, `formatElapsed`],
]);

// Prose is not a call site: the comments this repo writes quote the very shapes it bans.
const COMMENT = /^\s*(?:\/\/|\*|\/\*|<!--)/;

const lineAt = (text, index) => text.slice(0, index).split(`\n`).length;

/** Every hand-made formatting in `text`, as `{ line, why }`, less the ones a `// allow(format-tiers): <reason>` excuses. */
export const formatCalls = (text) => {
    const lines = text.split(`\n`);
    const found = [];
    for (const [index, line] of lines.entries()) {
        if (COMMENT.test(line)) {
            continue;
        }
        for (const [shape, why] of BY_HAND) {
            const match = shape.exec(line);
            if (match !== null) {
                found.push({ line: index + 1, why: why(match[0]) });
            }
        }
    }
    for (const match of text.matchAll(BASE_IMPORT)) {
        for (const name of match[1].split(`,`).map((part) => part.trim().replace(/^type\s+/, ``).split(/\s+as\s+/)[0])) {
            const kit = BASE_LABELS.get(name);
            if (kit !== undefined) {
                const at = match.index + match[0].indexOf(name);
                found.push({ line: lineAt(text, at), why: `${name} from @intentic/base is English and fixed; the kit's ${kit} follows the reader's language` });
            }
        }
    }
    return found.filter(({ line }) => !allowedAt(lines, line, `format-tiers`)).toSorted((a, b) => a.line - b.line);
};
