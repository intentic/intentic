// Where an install command says it writes, read from its own flags rather than from where the shell stands.

// The value a directory flag carries, spelled either `--dir x` or `--dir=x`.
export const flaggedDir = (words: readonly string[], flags: ReadonlySet<string>): string | undefined => {
    for (const [index, word] of words.entries()) {
        if (flags.has(word)) {
            return words[index + 1];
        }
        const joined = [...flags].find((flag) => flag.startsWith("--") && word.startsWith(`${flag}=`));
        if (joined !== undefined) {
            return word.slice(joined.length + 1);
        }
    }
    return undefined;
};

// The flag that sends each installer's output to a folder of the caller's choosing, by installer.
const FOLDER_FLAGS = new Map<string, ReadonlySet<string>>([
    ...["npm", "pnpm", "yarn", "bun", "corepack"].map((name) => [name, new Set(["--prefix"])] as const),
    ["cargo", new Set(["--root"])],
    ...["pip", "pip3", "uv"].map((name) => [name, new Set(["--target", "-t", "--prefix", "--root"])] as const),
]);

// The prefixes a global install writes to anyway: naming one still puts the tool on this container's PATH.
const SYSTEM_PREFIXES = new Set(["/usr", "/usr/local"]);

// An install into a folder of its own (`npm -g --prefix /tmp/x`, `cargo install --root out`, `pip --target dir`) lands
// outside the container's tool dirs, so no image step would give back what it made: it is not an image install.
export const intoOwnFolder = (executable: string, words: readonly string[]): boolean => {
    const flags = FOLDER_FLAGS.get(executable);
    const dir = flags === undefined ? undefined : flaggedDir(words, flags);
    return dir !== undefined && !SYSTEM_PREFIXES.has(dir.replace(/\/+$/, ""));
};
