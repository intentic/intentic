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
