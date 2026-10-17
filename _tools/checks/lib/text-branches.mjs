// THE READING dependency-text.mjs applies to one file: every line that branches on another program's words, minus the
// ones excused with `// allow(dependency-text): <reason>`. A pure function of the text, so its test pins it directly.
import { allowedAt } from "./allow.mjs";

// The methods that read text for words.
const SEARCH = String.raw`(?:includes|startsWith|endsWith|match|matchAll|search|indexOf)`;
// A thrown failure's message: `.message`, or what errorMessage() reads off one.
const MESSAGE = String.raw`(?:\.message\b|\berrorMessage\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\))`;
// A child process's stderr: the field, the shared reader, or a variable of that name.
const STDERR = String.raw`\bstderr(?:Of\([^()\n]*\))?`;

// Each way code branches on another program's words.
const TEXT_BRANCHES = [
    { id: `a failure's message compared to a literal`, pattern: new RegExp(String.raw`${MESSAGE}\s*[!=]==?\s*["'\`]|["'\`]\s*[!=]==?\s*[\w$.?]*\.message\b`, `g`) },
    { id: `a failure's message searched for words`, pattern: new RegExp(String.raw`${MESSAGE}(?:\s*\?\?\s*["'\`]{2})?\s*\??\.${SEARCH}\(`, `g`) },
    { id: `a failure's message tested by a pattern`, pattern: new RegExp(String.raw`\.(?:test|exec)\(\s*(?:[\w$.?]*${MESSAGE})`, `g`) },
    { id: `a child's stderr searched for words`, pattern: new RegExp(String.raw`${STDERR}(?:\s*\?\?\s*["'\`]{2})?[^;\n=]{0,40}?\??\.${SEARCH}\(`, `g`) },
    { id: `a child's stderr tested by a pattern`, pattern: new RegExp(String.raw`\.(?:test|exec)\(\s*[^)\n]{0,40}?${STDERR}`, `g`) },
];

// Comments say what a branch is without being one: blank them, keeping offsets so line numbers still match. Strings stay,
// since the literal a message is compared with is part of the shape.
const uncommented = (text) =>
    text.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\"'`])\/\/[^\n]*/g, (match, lead = ``) => lead + match.slice(lead.length).replace(/[^\n]/g, ` `));

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

// Each line of `text` that branches on another program's words and says nothing of why, with what it does, in line order.
// One finding per line: two readings on one test are one branch on one sentence.
export const textBranches = (text) => {
    const lines = text.split(`\n`);
    const code = uncommented(text);
    const here = new Map();
    for (const branch of TEXT_BRANCHES) {
        for (const match of code.matchAll(branch.pattern)) {
            const line = lineOf(code, match.index);
            if (!here.has(line) && !allowedAt(lines, line, `dependency-text`)) {
                here.set(line, branch.id);
            }
        }
    }
    return [...here].toSorted(([a], [b]) => a - b).map(([line, why]) => ({ line, why }));
};
