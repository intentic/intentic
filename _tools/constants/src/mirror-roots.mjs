// Directories an isolated turn's overlay mounts over (node_modules, .venv, dist, generated): emptying them is safe, but
// replacing the directory (rm -rf then mkdir) orphans the mount at its old inode, and only umount/mount repairs it.
// _tools/checks/mirror-roots.mjs refuses the replacing shape; clean-outputs.mjs does the emptying instead.

// Overlaid directory names; `.cache` is deliberately excluded and `.venv` is python's node_modules.
export const MIRRORED_DIRS = new Set(["node_modules", ".venv", "dist", "generated"]);

// Last path segment, quotes and trailing slash stripped; `dist/*` (contents) is not a match, only the directory itself
// is.
const lastSegment = (token) => {
    const bare = token.replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
    return bare.slice(bare.lastIndexOf("/") + 1);
};

// Splits into shell words, keeping quotes so lastSegment can strip them (and `'{}'` reads as find's placeholder); not a
// shell parser.
const tokenize = (segment) => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

// Verbs that remove a directory, and words that may precede one; the word before tells command from argument.
const REMOVERS = new Set(["rm", "rmdir", "rimraf"]);
const RUNNERS = new Set(["exec", "-exec", "-execdir", "sudo", "xargs", "then", "do", "else", "{", "(", "npx", "pnpm", "bunx", "yarn"]);
// Recursive rm flags (-rf, -fr, -Rf, -r, --recursive); a non-recursive rm can't take a directory at all.
const RECURSIVE = /^(?:--recursive$|-[a-zA-Z]*[rR])/;
// Where a find -exec command ends; everything after belongs to find again.
const EXEC_END = new Set([";", "\\;", "+"]);
const PLACEHOLDER = /^['"]?\{\}['"]?$/;
// find predicates naming what will be removed.
const NAME_PREDICATES = new Set(["-name", "-iname", "-path", "-wholename", "-ipath"]);

// Mirror roots a shell command would replace, split into commands on &&/;/|. Recognizes a literal removal and a find
// whose predicates name what -exec/-delete removes; over-reports a pruned name rather than parsing -o/-prune.
export const replacedMirrorRoots = (command) => {
    const found = [];
    for (const segment of command.split(/\|\||&&|[;|\n]/)) {
        const tokens = tokenize(segment);
        // `-mindepth 1` (or deeper) makes every removal in this command an emptying rather than a replacement.
        const shallowest = tokens.indexOf("-mindepth");
        if (shallowest !== -1 && Number(tokens[shallowest + 1]) >= 1) {
            continue;
        }
        const named = tokens.flatMap((token, at) => (NAME_PREDICATES.has(token) && tokens[at + 1] !== undefined ? [tokens[at + 1]] : []));
        // `find -delete` removes what the predicates name, with no `rm` on the line to notice.
        if (tokens.includes("-delete")) {
            found.push(...named.filter((token) => MIRRORED_DIRS.has(lastSegment(token))));
        }
        for (const [at, token] of tokens.entries()) {
            const before = tokens[at - 1];
            if (!REMOVERS.has(token) || (before !== undefined && !RUNNERS.has(before))) {
                continue;
            }
            const operands = [];
            let recursive = token !== "rm";
            for (const word of tokens.slice(at + 1)) {
                if (EXEC_END.has(word)) {
                    break;
                }
                if (word.startsWith("-")) {
                    recursive ||= RECURSIVE.test(word);
                    continue;
                }
                operands.push(word);
            }
            if (!recursive) {
                continue;
            }
            for (const operand of operands) {
                // A `{}` is find's placeholder: it stands for whatever the predicates named.
                const targets = PLACEHOLDER.test(operand) ? named : [operand];
                found.push(...targets.filter((target) => MIRRORED_DIRS.has(lastSegment(target))));
            }
        }
    }
    return [...new Set(found)];
};
