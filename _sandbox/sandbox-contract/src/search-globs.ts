/* What the search box's second field MEANS — VSCode's "files to include" grammar, read the way VSCode reads it
 * (its queryBuilder's parseSearchPaths + expandGlobalGlob), and answered as the two path-glob lists the search
 * engine takes.
 *
 * The rules that make it feel like the editor's field, each one load-bearing:
 *
 *   `package.json`  a bare name is a FILE as well as a folder — every segment expands to BOTH `**\/p` and
 *                   `**\/p/**`. Reading it as a folder alone is what made a file name find nothing.
 *   `src/db`        a path is still matched at any depth, not anchored — `**\/src/db`. VSCode only anchors
 *   `./src/db`      when the segment starts with `./` (or `/`), which is how you say "the one at the root".
 *   `.ts`           a leading dot is shorthand for the extension: it becomes `*.ts`.
 *   `docs/`         a trailing slash is noise; the folder form is generated either way.
 *   `*.{ts,vue}`    commas separate patterns EXCEPT inside `{…}` or `[…]`, which are one pattern's own syntax.
 *   `!**\/*.spec.ts` a leading `!` excludes. This is ours, not VSCode's — the editor spends a second box on
 *                   exclusions and the explorer's sidebar has room for one field.
 *
 * It lives in the contract package because both ends run it: the daemon turns it into engine scope, and the
 * recorded demo answers /workspace/search itself. Two readings of one field would make the same text mean
 * different things depending on which one answered. */

// VSCode's splitGlobAware: the split character is inert inside a brace group or a character class, so
// `*.{ts,py}` and `f[a,b].ts` survive as single patterns.
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

/* One typed segment → the globs that answer it. The pair is the whole trick: `p` matches the file, `p/**`
 * matches everything under a folder of that name, and either may be what the reader meant.
 *
 * `./p` and `/p` anchor at the workspace root; the `./` is kept on the way out because that is exactly how the
 * engine's glob distinguishes an anchored pattern from a name it should look for at any depth. */
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
    // ".ts" is how people write an extension filter; VSCode reads it as "*.ts" rather than as a hidden file.
    const pattern = trimmed.startsWith(`.`) ? `*${trimmed}` : trimmed;
    return [`**/${pattern}`, `**/${pattern}/**`];
};

export interface IncludeGlobs {
    // Files the search is limited to — empty means the whole workspace. OR'ed: any pattern matching admits.
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
