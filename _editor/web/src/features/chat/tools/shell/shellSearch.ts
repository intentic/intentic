import { type PathRef, LINE_FILTERS, ROW_CAP, filtersAre, mostly, parseArgs, pathLike, pathRef } from "./shellArgs";
import type { ShellCommand } from "./shellLex";

// A search's output as hits grouped by file (rg, grep, git grep), and a listing's as paths (find, fd, rg --files, and a
// search asked only for file names).

export interface MatchHit {
    readonly line: number | undefined;
    readonly text: string;
    // A `-C` context line rather than a hit.
    readonly context: boolean;
}

export interface MatchFile extends PathRef {
    readonly hits: readonly MatchHit[];
}

// What a search was looking for, as a JS pattern, to mark in its hits; absent when it would not translate.
export interface MatchMark {
    readonly source: string;
    readonly flags: string;
}

export interface MatchesSection {
    readonly kind: `matches`;
    readonly files: readonly MatchFile[];
    readonly hits: number;
    readonly mark: MatchMark | undefined;
}

export interface PathsSection {
    readonly kind: `paths`;
    readonly entries: readonly PathRef[];
}

// SEARCHES: rg, grep and git grep, their hits grouped by file.
const RG_VALUED = new Set([
    `-g`,
    `--glob`,
    `--iglob`,
    `-t`,
    `--type`,
    `-T`,
    `--type-not`,
    `-A`,
    `-B`,
    `-C`,
    `-m`,
    `--max-count`,
    `-e`,
    `--regexp`,
    `-f`,
    `--file`,
    `-M`,
    `--max-columns`,
    `-j`,
    `--threads`,
    `--sort`,
    `--sortr`,
    `--color`,
    `--colors`,
    `--type-add`,
    `-E`,
    `--encoding`,
    `--max-depth`,
    `-d`,
    `--max-filesize`,
    `-r`,
    `--replace`,
    `--pre`,
    `--engine`,
    `--context-separator`,
]);
const GREP_VALUED = new Set([
    `-e`,
    `--regexp`,
    `-f`,
    `--file`,
    `-A`,
    `-B`,
    `-C`,
    `-m`,
    `--max-count`,
    `--include`,
    `--exclude`,
    `--exclude-dir`,
    `-d`,
    `-D`,
    `--color`,
    `--colour`,
]);
const LISTING_FLAGS = [`l`, `L`, `files`, `files-with-matches`, `files-without-match`];
const COUNT_FLAGS = [`c`, `count`, `count-matches`];

// grep's basic regex escapes the operators a JS pattern leaves bare, and leaves bare what JS escapes.
const fromBasicRegex = (pattern: string): string =>
    pattern.replace(/\\([|(){}+?])|([|(){}+?])/g, (_whole, escaped: string | undefined, bare: string | undefined) => escaped ?? `\\${bare}`);

const markOf = (pattern: string | undefined, program: string, flags: ReadonlySet<string>): MatchMark | undefined => {
    if (pattern === undefined || pattern === ``) {
        return undefined;
    }
    const fixed = flags.has(`F`) || flags.has(`fixed-strings`) || program === `fgrep`;
    const basic = (program === `grep` || program === `git-grep`) && !flags.has(`E`) && !flags.has(`P`) && !flags.has(`extended-regexp`);
    const source = fixed ? pattern.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`) : basic ? fromBasicRegex(pattern) : pattern;
    try {
        const compiled = new RegExp(flags.has(`w`) ? `\\b(?:${source})\\b` : source, flags.has(`i`) || flags.has(`ignore-case`) ? `gi` : `g`);
        return { source: compiled.source, flags: compiled.flags };
    } catch {
        // allow(silent-catch): a pattern JS cannot read (rg's own syntax, a lookbehind it lacks) only goes unmarked
        return undefined;
    }
};

const HIT = /^([^\s:]+?):(\d+)([:-])(.*)$/s;
const CONTEXT = /^([^\s:]+?)-(\d+)-(.*)$/s;
const BARE_HIT = /^(\d+)([:-])(.*)$/s;

// One output line of a search as file, line and text; `single` is the one file searched, whose lines carry no name.
const parseHit = (line: string, single: string | undefined): { path: string; hit: MatchHit } | undefined => {
    const named = HIT.exec(line) ?? CONTEXT.exec(line);
    if (named !== null && pathLike(named[1]!)) {
        const context = named === CONTEXT.exec(line) || named[3] === `-`;
        return { path: named[1]!, hit: { line: Number(named[2]), text: named[4] ?? named[3]!, context } };
    }
    if (single === undefined) {
        const loose = /^([^\s:]+):(.*)$/s.exec(line);
        return loose !== null && pathLike(loose[1]!) ? { path: loose[1]!, hit: { line: undefined, text: loose[2]!, context: false } } : undefined;
    }
    const bare = BARE_HIT.exec(line);
    return bare === null
        ? { path: single, hit: { line: undefined, text: line, context: false } }
        : { path: single, hit: { line: Number(bare[1]), text: bare[3]!, context: bare[2] === `-` } };
};

const groupHits = (parsed: readonly { path: string; hit: MatchHit }[], cwd: string | undefined): MatchFile[] => {
    const files = new Map<string, MatchHit[]>();
    for (const { path, hit } of parsed.slice(0, ROW_CAP)) {
        files.set(path, [...(files.get(path) ?? []), hit]);
    }
    return [...files].map(([path, hits]) => ({ ...pathRef(path, cwd), hits }));
};

const pathsSection = (text: string, cwd: string | undefined): PathsSection | undefined => {
    const lines = text.split(`\n`).filter((line) => line.trim() !== ``);
    const paths = lines.map((line) => line.trim().replace(/:\d+$/, ``)).filter(pathLike);
    return mostly(paths.length, lines.length) ? { kind: `paths`, entries: paths.slice(0, ROW_CAP).map((path) => pathRef(path, cwd)) } : undefined;
};

export const searchSection = (
    head: ShellCommand,
    filters: readonly ShellCommand[],
    text: string,
    cwd: string | undefined,
): MatchesSection | PathsSection | undefined => {
    const [first = ``, ...rest] = head.argv;
    const program = first === `git` && rest[0] === `grep` ? `git-grep` : first;
    const args = program === `git-grep` ? rest.slice(1) : rest;
    if (![`rg`, `grep`, `egrep`, `fgrep`, `git-grep`].includes(program) || !filtersAre(filters, LINE_FILTERS)) {
        return undefined;
    }
    const { flags, values, positional } = parseArgs(args, program === `rg` ? RG_VALUED : GREP_VALUED);
    if (COUNT_FLAGS.some((flag) => flags.has(flag))) {
        return undefined;
    }
    if (LISTING_FLAGS.some((flag) => flags.has(flag))) {
        return pathsSection(text, cwd);
    }
    const explicit = values.get(`e`) ?? values.get(`regexp`);
    const pattern = explicit ?? positional[0];
    const paths = explicit === undefined ? positional.slice(1) : positional;
    const single = paths.length === 1 && !head.expands.at(-1) && !flags.has(`r`) && !flags.has(`R`) ? paths[0] : undefined;
    const lines = text.split(`\n`).filter((line) => line !== `--` && line !== ``);
    const parsed = lines.map((line) => parseHit(line, single)).filter((entry) => entry !== undefined);
    if (!mostly(parsed.length, lines.length)) {
        return undefined;
    }
    return {
        kind: `matches`,
        files: groupHits(parsed, cwd),
        hits: parsed.filter((entry) => !entry.hit.context).length,
        mark: markOf(pattern, program, flags),
    };
};

export const listSection = (
    head: ShellCommand,
    filters: readonly ShellCommand[],
    text: string,
    cwd: string | undefined,
): PathsSection | undefined => {
    const [program = ``, ...args] = head.argv;
    const lists =
        [`find`, `fd`, `fdfind`].includes(program) || (program === `rg` && args.includes(`--files`)) || (program === `git` && args[0] === `ls-files`);
    return lists && filtersAre(filters, LINE_FILTERS) ? pathsSection(text, cwd) : undefined;
};
