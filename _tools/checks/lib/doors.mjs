// The door checks' one skeleton. Each rule in doors.rules.mjs names a concern's subjects, the shapes that reach past its
// door and the door to use instead; this lists the subjects, finds the sites by shape, drops the ones a site comment
// excuses, holds the rest to a baseline where the rule keeps one, and answers the way that check always has.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowingLine, pragmaReason } from "./allow.mjs";
import { ADOPTING, ratchet } from "./ratchet.mjs";
import { finish } from "./report.mjs";
import { root, subjectFiles } from "./repo.mjs";
import { blank, finishFindings } from "./templates.mjs";

const blanked = (match) => match.replace(/[^\n]/g, ` `);

// What a rule reads past as prose, blanked so every offset keeps its line. `lines` instead skips a whole line that
// opens as a comment, and `none` reads everything.
const COMMENTS = {
    none: (text) => text,
    lines: (text) => text,
    // `//` and `/* */`, a `//` after a URL's colon or an escape left alone.
    code: (text) =>
        text.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (match, lead = ``) => lead + match.slice(lead.length).replace(/[^\n]/g, ` `)),
    // `/* */` and the lines a `//` opens. A trailing `//` after code is left: telling it from a URL in a string would
    // need a tokenizer.
    leading: (text) => text.replace(/\/\*[\s\S]*?\*\//g, blanked).replace(/^[ \t]*\/\/[^\n]*/gm, (line) => ` `.repeat(line.length)),
    // `<!-- -->` and `//`, but not `/* */`.
    markup: (text) =>
        text.replace(/<!--[\s\S]*?-->/gu, blanked).replace(/(^|[^:\\])\/\/[^\n]*/gu, (match, lead) => lead + ` `.repeat(match.length - lead.length)),
    // A template's markup alone: `<script>`, `<style>` and `<!-- -->` blanked.
    template: blank,
};

// A line that opens as a comment, for the `lines` rules.
const PROSE = /^\s*(?:\/\/|\*|\/\*|<!--)/;

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

const matchesOf = (reach, text) => (reach.global ? [...text.matchAll(reach)] : [reach.exec(text)].filter((match) => match !== null));

// One pattern's sites: per line past the lines that open as prose for a `lines` rule, else over the blanked code.
const sitesOf = (rule, { reach, why }, lines, code) =>
    rule.comments === `lines`
        ? lines.flatMap((line, index) => (PROSE.test(line) ? [] : matchesOf(reach, line)).map((match) => ({ line: index + 1, why: why(match) })))
        : matchesOf(reach, code).map((match) => ({ line: lineOf(code, match.index), why: why(match) }));

// Every site the rule's patterns and `find` read in one file, before any comment excuses one.
const candidatesOf = (rule, path, text, lines) => {
    const patterns = (rule.patterns ?? []).filter((pattern) => pattern.within === undefined || pattern.within(path, text));
    if (patterns.length === 0 && rule.find === undefined) {
        return [];
    }
    const code = COMMENTS[rule.comments](text);
    const found = patterns.flatMap((pattern) => sitesOf(rule, pattern, lines, code));
    for (const site of rule.find?.(code, path, text) ?? []) {
        found.push({ line: site.line ?? lineOf(code, site.index), why: site.why });
    }
    return found;
};

/**
 * Every site `rule` finds in one file, as `{ line, why }` less the ones an `allow(<rule.allow>)` comment excuses, and
 * `idle`: the lines of those comments that excuse nothing. A pattern without the `g` flag finds its first site only.
 */
export const findSites = (rule, path, text) => {
    const lines = text.split(`\n`);
    const found = candidatesOf(rule, path, text, lines);
    if (rule.allow === false) {
        return { sites: rule.sort === true ? found.toSorted((a, b) => a.line - b.line) : found, idle: [] };
    }
    const used = new Set();
    const sites = found.filter(({ line }) => {
        const by = allowingLine(lines, line, rule.allow);
        used.add(by);
        return by === undefined;
    });
    const pragmas = text.includes(`allow(${rule.allow})`)
        ? lines.flatMap((line, index) => (pragmaReason(line, rule.allow) === undefined ? [] : [index + 1]))
        : [];
    return { sites: rule.sort === true ? sites.toSorted((a, b) => a.line - b.line) : sites, idle: pragmas.filter((line) => !used.has(line)) };
};

/** Runs one rule over the tree, or over `--paths` when given, and answers with its report. */
export const runDoorRule = (rule) => {
    const subjects = subjectFiles(...rule.roots).filter((path) => rule.subjects(path));
    const found = new Map();
    const idle = [];
    for (const path of subjects) {
        const { sites, idle: lines } = findSites(rule, path, readFileSync(join(root, path), `utf8`));
        if (sites.length > 0) {
            found.set(path, sites);
        }
        idle.push(
            ...lines.map((line) => ({
                at: `${path}:${line}`,
                why: `allow(${rule.allow}) excuses nothing here: drop it, or move it onto the site it means`,
            })),
        );
    }
    const counts = new Map([...found].map(([path, sites]) => [path, sites.length]));
    const grown = rule.ratchet === true ? ratchet(rule.id, rule.id, counts).grown : [...counts].map(([key, count]) => ({ key, count, allowed: 0 }));
    if (rule.ratchet === true && ADOPTING) {
        process.exit(0);
    }
    const standing = [...counts.values()].reduce((sum, count) => sum + count, 0);
    const vouched = rule.report.vouched({ files: subjects.length, standing });
    if (rule.report.summary !== undefined) {
        const findings = [...found].flatMap(([path, sites]) => sites.map(({ line, why }) => ({ at: `${path}:${line}`, why })));
        finishFindings([...findings, ...idle], rule.report.summary, vouched);
        return;
    }
    const problems = grown.flatMap(({ key, count, allowed }) => [
        ...found.get(key).map(({ line, why }) => `${key}:${line}  ${why}`),
        ...(rule.report.baseline?.(key, count, allowed) ?? []),
    ]);
    finish(
        [
            [rule.report.heading, problems],
            [`an allow(${rule.allow}) comment that excuses nothing`, idle.map(({ at, why }) => `${at}  ${why}`)],
        ],
        [vouched],
    );
};
