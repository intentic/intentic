// What daemon-doors.mjs reads a file for: the places the editor reaches the daemon around its one typed door, by shape,
// since the checks run before install. Kept apart from the check so its suite can feed it text.
import { allowedAt } from "./allow.mjs";

// A path spelled to the bare client, whatever the seam it goes through: `sandboxJson(`/x`)`, `sandboxJson<T>(`/x`)`,
// `deps.sandboxJson(`/x`)`, `(post ?? sandboxRequest)(`/x`)`. A path in a variable is not a spelling, and the extension API's
// own `request`/`json` pass-through takes whatever path the extension names.
const SPELLED = /\bsandbox(?:Json|Request)\b[)\s]*(?:<[^>()]*>)?\(\s*[`'"]\//g;

// A fetch aimed at a path built from the route table: the raw call that waits on none of the client's headers, retries or
// session. Only a window of one statement, since `fetch(` and `rawRouteUrl(` far apart are unrelated.
const AROUND = /\b\w*[fF]etch\w*\s*\(\s*[^;]{0,200}?\brawRouteUrl\s*\(/g;

const KINDS = [
    { pattern: SPELLED, why: `a daemon path spelled to sandboxJson/sandboxRequest: call the route by its key through sandboxRaw (RAW_JSON_ROUTES in the contract), and add the route there when it is missing` },
    { pattern: AROUND, why: `a fetch of a rawRouteUrl path goes around the client's session, retry and drift handling: use sandboxRaw, or say why this call must stay raw` },
];

// Comments say what a shape is without being one: blanked, keeping offsets so line numbers still match.
const uncommented = (text) =>
    text.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (match, lead = ``) => lead + match.slice(lead.length).replace(/[^\n]/g, ` `));

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

/** Every such reach in `text`, as `{ line, why }`, less the ones a `// allow(daemon-doors): <reason>` excuses. */
export const daemonDoorCalls = (text) => {
    const lines = text.split(`\n`);
    const code = uncommented(text);
    const found = [];
    for (const { pattern, why } of KINDS) {
        for (const match of code.matchAll(pattern)) {
            found.push({ line: lineOf(code, match.index), why });
        }
    }
    return found.filter(({ line }) => !allowedAt(lines, line, `daemon-doors`)).toSorted((a, b) => a.line - b.line);
};
