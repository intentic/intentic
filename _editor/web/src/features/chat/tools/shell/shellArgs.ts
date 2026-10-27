import type { ShellCommand } from "./shellLex";

// The small readings every shell recogniser shares: a command's options and positionals, where a printed path opens,
// and how sure a line-by-line parse has to be before its shape is believed.

export interface PathRef {
    // As the command printed it.
    readonly path: string;
    // Resolved against the directory the command ran in, for opening.
    readonly open: string;
}

// Rows past which a listing or a search stops drawing; the summary still counts them all.
export const ROW_CAP = 300;
// Filters a listing's lines pass through and still come out as lines of the same kind.
export const LINE_FILTERS = new Set([`head`, `tail`, `sort`, `uniq`, `grep`, `rg`, `cut`]);

// `a/b` against `/work/x` is `/work/x/a/b`; `./a` loses its dot; an absolute path stays.
export const resolvePath = (path: string, cwd: string | undefined): string => {
    const bare = path.replace(/^(?:\.\/)+/, ``);
    if (bare.startsWith(`/`) || cwd === undefined) {
        return bare;
    }
    return `${cwd.replace(/\/+$/, ``)}/${bare}`;
};

export const pathRef = (path: string, cwd: string | undefined): PathRef => ({ path, open: resolvePath(path, cwd) });

// A segment that names a file: a directory in it, or a dot-extension; no spaces.
export const pathLike = (text: string): boolean => !/\s/.test(text) && !text.startsWith(`-`) && (text.includes(`/`) || /\.[A-Za-z0-9]+$/.test(text));

export const trimBlankLines = (text: string): string => text.replace(/^(?:[ \t]*\n)+/, ``).replace(/(?:\n[ \t]*)+$/, ``);

export const mostly = (matched: number, total: number): boolean => total > 0 && matched * 5 >= total * 3;

// Options and positionals of one command; `valued` names the options that take the next word (or the rest of a cluster).
export interface Parsed {
    readonly flags: ReadonlySet<string>;
    readonly values: ReadonlyMap<string, string>;
    readonly positional: readonly string[];
}

const takeLong = (
    word: string,
    next: string | undefined,
    valued: ReadonlySet<string>,
    out: { flags: Set<string>; values: Map<string, string> },
): number => {
    const equals = word.indexOf(`=`);
    const name = equals === -1 ? word.slice(2) : word.slice(2, equals);
    const inline = equals === -1 ? undefined : word.slice(equals + 1);
    out.flags.add(name);
    if (inline !== undefined) {
        out.values.set(name, inline);
        return 0;
    }
    if (valued.has(`--${name}`) && next !== undefined) {
        out.values.set(name, next);
        return 1;
    }
    return 0;
};

const takeShort = (
    word: string,
    next: string | undefined,
    valued: ReadonlySet<string>,
    out: { flags: Set<string>; values: Map<string, string> },
): number => {
    for (let at = 1; at < word.length; at += 1) {
        const letter = word[at]!;
        out.flags.add(letter);
        if (valued.has(`-${letter}`)) {
            const rest = word.slice(at + 1);
            out.values.set(letter, rest !== `` ? rest : (next ?? ``));
            return rest !== `` ? 0 : 1;
        }
    }
    return 0;
};

export const parseArgs = (args: readonly string[], valued: ReadonlySet<string>): Parsed => {
    const out = { flags: new Set<string>(), values: new Map<string, string>() };
    const positional: string[] = [];
    for (let at = 0; at < args.length; at += 1) {
        const word = args[at]!;
        if (word === `--`) {
            positional.push(...args.slice(at + 1));
            break;
        }
        if (word.startsWith(`--`)) {
            at += takeLong(word, args[at + 1], valued, out);
        } else if (word.startsWith(`-`) && word.length > 1 && !/^-\d+$/.test(word)) {
            at += takeShort(word, args[at + 1], valued, out);
        } else if (/^-\d+$/.test(word)) {
            out.values.set(`n`, word.slice(1));
        } else {
            positional.push(word);
        }
    }
    return { ...out, positional };
};

export const filtersAre = (filters: readonly ShellCommand[], allowed: ReadonlySet<string>): boolean =>
    filters.every((command) => allowed.has(command.argv[0] ?? ``) && !command.argv.some((word) => word === `-c` || word === `--count`));
