// What home-dir.mjs reads a file for: every `homedir(` it spells, comments included, since the rule it carries over
// read the whole text. Kept apart from the check so its suite can feed it text.

// `os.homedir()`, `homedir()` imported bare, and either split across a line before its parenthesis.
const HOMEDIR = /\bhomedir\s*\(/g;

/** The 1-based line of each `homedir(` in `text`. */
export const homeDirCalls = (text) => [...text.matchAll(HOMEDIR)].map((match) => text.slice(0, match.index).split("\n").length);
