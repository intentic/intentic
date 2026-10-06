// Where a daemon module starts a process by hand: a `node:child_process` spawn/exec/execFile (or a sync twin) called
// directly, or exec/execFile promisified into a local. Read by shape, like every check here: the import names which
// locals are child_process's, so an alias (`spawn as nodeSpawn`) and a namespace (`cp.spawn`) are followed, and a
// type-only import is not a use.
import { allowedAt } from "./allow.mjs";

// The calls that start a process outside workload/run-check.ts and spawnAs.
export const STARTERS = new Set([`spawn`, `spawnSync`, `exec`, `execSync`, `execFile`, `execFileSync`]);

const IMPORT = /import\s+(type\s+)?([^;]*?)\s+from\s+["'](?:node:)?child_process["']/g;
const escaped = (name) => name.replace(/[$]/g, `\\$&`);

// The locals one file binds to child_process's starters, and the namespaces it binds the module to.
const bindingsOf = (text) => {
    const named = new Map();
    const namespaces = [];
    for (const match of text.matchAll(IMPORT)) {
        if (match[1] !== undefined) {
            continue;
        }
        const clause = match[2];
        const star = /\*\s+as\s+([\w$]+)/.exec(clause);
        if (star !== null) {
            namespaces.push(star[1]);
        }
        const fallback = /^([\w$]+)\s*(?:,|$)/.exec(clause.trim());
        if (fallback !== null) {
            namespaces.push(fallback[1]);
        }
        const braces = /\{([^}]*)\}/.exec(clause);
        for (const entry of braces === null ? [] : braces[1].split(`,`)) {
            const spec = entry.trim();
            if (spec === `` || spec.startsWith(`type `)) {
                continue;
            }
            const [imported, local = imported] = spec.split(/\s+as\s+/).map((part) => part.trim());
            if (STARTERS.has(imported)) {
                named.set(local, imported);
            }
        }
    }
    return { named, namespaces };
};

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

// Comment lines and blocks blanked to spaces, so prose naming a call is not one and every index keeps its line. A
// trailing `//` after code is left: telling it from a URL in a string would need a tokenizer.
const uncommented = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ` `)).replace(/^[ \t]*\/\/[^\n]*/gm, (line) => ` `.repeat(line.length));

/**
 * Every hand-started process in one file's text, `{ line, what }`, minus the ones excused at their site with
 * `// allow(process-tiers): <reason>`.
 */
export const processCalls = (text) => {
    const { named, namespaces } = bindingsOf(text);
    if (named.size === 0 && namespaces.length === 0) {
        return [];
    }
    const lines = text.split(`\n`);
    const code = uncommented(text);
    const found = [];
    const note = (index, what) => {
        const line = lineOf(text, index);
        if (!allowedAt(lines, line, `process-tiers`)) {
            found.push({ line, what });
        }
    };
    for (const [local, imported] of named) {
        // promisify(execFile) is one finding; the local it makes is that finding's, not another.
        for (const match of code.matchAll(new RegExp(String.raw`\bpromisify\(\s*${escaped(local)}\s*\)`, `g`))) {
            note(match.index, `promisify(${imported})`);
        }
        for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$.])${escaped(local)}\s*\(`, `g`))) {
            note(match.index, `${imported}()`);
        }
    }
    for (const namespace of namespaces) {
        for (const match of code.matchAll(new RegExp(String.raw`(?<![\w$.])${escaped(namespace)}\.(\w+)\s*\(`, `g`))) {
            if (STARTERS.has(match[1])) {
                note(match.index, `${match[1]}()`);
            }
        }
    }
    return found.toSorted((a, b) => a.line - b.line);
};
