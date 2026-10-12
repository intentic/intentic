// What the search box's second field means: VSCode's "files to include" grammar, read the same way everywhere it runs
// (the daemon, the recorded demo):
// - a bare name matches both the file and the folder (`p` and `p/**`)
// - a path matches at any depth unless it starts with `./` or `/` (anchored to the root)
// - a leading dot is an extension shorthand (`.ts` becomes `*.ts`); a trailing slash is dropped
// - commas split patterns, except inside `{...}` or `[...]`
// - a leading `!` excludes; this app's own addition, not VSCode's

// VSCode's splitGlobAware: the split character is inert inside a brace group or character class.
const splitPatterns = (include: string, splitChar: string): string[] => {
    const segments: string[] = [];
    let current = ``;
    let inBraces = false;
    let inBrackets = false;
    for (const char of include) {
        if (char === splitChar && !inBraces && !inBrackets) {
            segments.push(current);
            current = ``;
            continue;
        }
        inBraces = char === `{` ? true : char === `}` ? false : inBraces;
        inBrackets = char === `[` ? true : char === `]` ? false : inBrackets;
        current += char;
    }
    segments.push(current);
    return segments.map((segment) => segment.trim()).filter((segment) => segment !== ``);
};

// One typed segment maps to two globs: the file itself, and everything under a folder of that name. An anchored form
// (`./p`, `/p`) keeps its `./` prefix, since that's how the engine tells "anchored" from "any depth".
const expand = (segment: string): string[] => {
    const trimmed = segment.replace(/\/+$/, ``);
    if (trimmed === ``) {
        return [];
    }
    const anchored = /^\.?\//.test(trimmed);
    if (anchored) {
        const path = trimmed.replace(/^\.?\//, ``).replace(/^\/+/, ``);
        return path === `` ? [] : [`./${path}`, `./${path}/**`];
    }
    // ".ts" is how people write an extension filter; VSCode reads it as "*.ts" rather than a hidden file.
    const pattern = trimmed.startsWith(`.`) ? `*${trimmed}` : trimmed;
    return [`**/${pattern}`, `**/${pattern}/**`];
};

export interface IncludeGlobs {
    // Files the search is limited to, empty means the whole workspace. OR'ed: any pattern matching admits.
    readonly globs: readonly string[];
    // Files kept out of it, whatever the includes said.
    readonly notGlobs: readonly string[];
}

export const includeGlobs = (include: string | undefined): IncludeGlobs => {
    const segments = splitPatterns(include ?? ``, `,`);
    return {
        globs: segments.filter((segment) => !segment.startsWith(`!`)).flatMap(expand),
        // A bare "!" excludes nothing; without this it would expand into a glob that matches everything.
        notGlobs: segments.filter((segment) => segment.startsWith(`!`)).flatMap((segment) => expand(segment.slice(1))),
    };
};

// ONE GLOB MATCHER, with Bun.Glob's reading of every construct, so the daemon, the desktop folder server (which runs
// Bun.Glob itself) and the demo admit the same files for the same pattern. Before this the daemon's copy took
// `[!t]` as a set of the characters `!` and `t`, where Bun.Glob reads "anything but t".
// - `*` is any run within one path segment, `?` one character of it
// - `**` as a whole segment is any number of segments, none included (`**/x` matches `x`); inside a segment it is `*`
// - `[abc]`, `[a-z]`, and `[!abc]` or `[^abc]` for "none of these"; a `]` first in the set is literal
// - `{a,b}` is either, nested groups and globs inside included; `\` makes the next character literal
// - an unclosed `[` or `{` is literal, where Bun.Glob matches nothing: a half-typed pattern then still finds its text
const REGEXP_SPECIAL = /[.*+?^${}()|[\]\\/]/;

const literal = (char: string): string => (REGEXP_SPECIAL.test(char) ? `\\${char}` : char);

// The index of the `]` closing the set opened at `open`, or -1.
const setEnd = (glob: string, open: number): number => {
    let index = open + 1;
    if (glob[index] === `!` || glob[index] === `^`) {
        index += 1;
    }
    // A `]` straight after the opening (or its negation) is a member, not the close.
    if (glob[index] === `]`) {
        index += 1;
    }
    for (; index < glob.length; index += 1) {
        if (glob[index] === `\\`) {
            index += 1;
        } else if (glob[index] === `]`) {
            return index;
        }
    }
    return -1;
};

const setSource = (body: string): string => {
    const negated = body.startsWith(`!`) || body.startsWith(`^`);
    const members = (negated ? body.slice(1) : body).replaceAll(/\\(.)/g, `$1`).replaceAll(/[\\\]^[]/g, (char) => `\\${char}`);
    return `[${negated ? `^` : ``}${members}]`;
};

// The index of the `}` closing the group opened at `open`, and where its top-level commas fall; undefined if unclosed.
const groupOf = (glob: string, open: number): { readonly end: number; readonly commas: readonly number[] } | undefined => {
    const commas: number[] = [];
    let depth = 0;
    for (let index = open; index < glob.length; index += 1) {
        const char = glob[index];
        if (char === `\\`) {
            index += 1;
        } else if (char === `[`) {
            const end = setEnd(glob, index);
            index = end === -1 ? index : end;
        } else if (char === `{`) {
            depth += 1;
        } else if (char === `}`) {
            depth -= 1;
            if (depth === 0) {
                return { end: index, commas };
            }
        } else if (char === `,` && depth === 1) {
            commas.push(index);
        }
    }
    return undefined;
};

// `**` filling a whole segment: the source it stands for and how many characters of the glob it consumed.
const globstar = (glob: string, index: number, segmentStart: boolean): { readonly source: string; readonly length: number } | undefined => {
    if (!segmentStart || glob[index + 1] !== `*`) {
        return undefined;
    }
    const after = glob[index + 2];
    if (after === `/`) {
        return { source: `(?:[^/]*/)*`, length: 3 };
    }
    return after === undefined ? { source: `.*`, length: 2 } : undefined;
};

const compileGlob = (glob: string, segmentStart: boolean): string => {
    let source = ``;
    let atStart = segmentStart;
    for (let index = 0; index < glob.length; index += 1) {
        const char = glob[index]!;
        const star = char === `*` ? globstar(glob, index, atStart) : undefined;
        if (star !== undefined) {
            source += star.source;
            index += star.length - 1;
            atStart = true;
            continue;
        }
        if (char === `*`) {
            // A run of stars inside a segment is one star.
            while (glob[index + 1] === `*`) {
                index += 1;
            }
            source += `[^/]*`;
        } else if (char === `?`) {
            source += `[^/]`;
        } else if (char === `\\` && index + 1 < glob.length) {
            index += 1;
            source += literal(glob[index]!);
        } else if (char === `[` && setEnd(glob, index) !== -1) {
            const end = setEnd(glob, index);
            source += setSource(glob.slice(index + 1, end));
            index = end;
        } else if (char === `{` && groupOf(glob, index) !== undefined) {
            const group = groupOf(glob, index)!;
            const bounds = [index, ...group.commas, group.end];
            const alternatives = bounds.slice(1).map((end, at) => compileGlob(glob.slice(bounds[at]! + 1, end), atStart));
            source += `(?:${alternatives.join(`|`)})`;
            index = group.end;
        } else {
            source += literal(char);
        }
        atStart = char === `/`;
    }
    return source;
};

// The whole path must match: `*.ts` is a name at the root, not a suffix anywhere.
export const globRegExp = (glob: string): RegExp => new RegExp(`^${compileGlob(glob, true)}$`);

// A matcher for slash-separated relative paths, compiled once.
export const globMatcher = (glob: string): ((path: string) => boolean) => {
    const pattern = globRegExp(glob);
    return (path) => pattern.test(path);
};

// The search box's whole second field as one test over a relative path: admitted by any include (or by none being
// typed), and by no exclude. An anchored include's `./` is the root, so it is dropped before matching.
export const includeMatcher = (include: string | undefined): ((path: string) => boolean) => {
    const { globs, notGlobs } = includeGlobs(include);
    const rooted = (glob: string): string => glob.replace(/^\.\//, ``);
    const admits = globs.map((glob) => globMatcher(rooted(glob)));
    const refuses = notGlobs.map((glob) => globMatcher(rooted(glob)));
    return (path) => (admits.length === 0 || admits.some((test) => test(path))) && !refuses.some((test) => test(path));
};
