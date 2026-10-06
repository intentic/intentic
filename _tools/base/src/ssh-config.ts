// The `Include` lines a tool manages in someone's ~/.ssh/config, read and rewritten as text, without touching anything
// else in the file. Both writers of such a line share it: the daemon's managed ssh hosts and the machine agent's sync
// aliases. A line counts only when ssh would read it: `# Include x` is a comment, not an include, so a commented-out
// line never stands in for the live one. Pure string work; the caller reads and writes the file (atomically: a crash
// mid-write must never truncate the user's whole config).

// `Include a b`, `include=a`, any case, any indentation; the trailing `\r` of a CRLF file is whitespace too.
const INCLUDE_LINE = /^[ \t]*include(?:[ \t]*=[ \t]*|[ \t]+)(.*?)[ \t\r]*$/i;

// The paths a line includes, quotes dropped; undefined for a line that is not a live Include (a comment, a blank, any
// other keyword).
export const includedPaths = (line: string): string[] | undefined => {
    const match = INCLUDE_LINE.exec(line);
    if (match === null) {
        return undefined;
    }
    return [...(match[1] ?? "").matchAll(/"([^"]*)"|(\S+)/g)].map((part) => part[1] ?? part[2] ?? "");
};

// A line this tool owns: a live Include of exactly one path that `ours` claims. A user's line that includes several
// paths is theirs, even when one of them is ours.
const isManagedLine = (line: string, ours: (path: string) => boolean): boolean => {
    const paths = includedPaths(line);
    return paths?.length === 1 && ours(paths[0] ?? "");
};

// Whether ssh would read one of our includes from this config.
export const hasManagedInclude = (config: string, ours: (path: string) => boolean): boolean =>
    config.split("\n").some((line) => isManagedLine(line, ours));

// The config with every one of our include lines gone, the user's own lines (comments included) left byte for byte.
export const withoutManagedIncludes = (config: string, ours: (path: string) => boolean): string =>
    config
        .split("\n")
        .filter((line) => !isManagedLine(line, ours))
        .join("\n");

// The config with exactly one of our includes, `line`, first: an Include below a `Host` block is scoped to that block,
// so only the top of the file applies it everywhere. Any earlier spelling of ours is dropped, so re-running cannot
// leave two. Equal to `config` when it already reads that way, so a caller can skip the write.
export const withManagedInclude = (config: string, line: string, ours: (path: string) => boolean): string =>
    `${line}\n${withoutManagedIncludes(config, ours)}`;
