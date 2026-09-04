/* THE DIRECTORIES AN ISOLATED TURN MOUNTS OVER, and the one thing the main checkout must never do to them.
 *
 * A worktree holds TRACKED files only, so the two trees a package's dependents resolve THROUGH — its installed
 * tree (`node_modules`) and its build output (`dist`, `generated`) — cannot be checked out and have to come
 * from the main tree. The daemon supplies them as overlayfs mounts, one per directory, the MAIN checkout's copy
 * as the lowerdir and a per-conversation upper layer for whatever the turn writes
 * (_sandbox/sandbox/src/agents/isolation.ts, which imports this set rather than keeping its own).
 *
 * AN OVERLAY RESOLVES ITS LOWERDIR ONCE, AT MOUNT TIME, and holds that dentry for the life of the mount.
 * Rewriting the FILES inside it is harmless, and that is the whole reason mirroring a build directory works at
 * all: measured on this image (ext4 lower, kernel 6.18), unlinking every file in the lower root and writing new
 * ones is picked up by the merged view immediately, entry for entry. REPLACING THE DIRECTORY ITSELF is not.
 * `rm -rf dist` followed by a `mkdir` gives that path a new inode; the mount keeps pointing at the old one, and
 * the merged directory then reads as COMPLETELY EMPTY — not even the entries in the turn's own upper layer,
 * though `stat` on any of those upper files still succeeds, which is what makes the symptom so hard to read.
 * `mount -o remount` does not repair it. Only umount/mount does, and nothing inside the turn can do either: the
 * mount root is the one lower directory a turn cannot shadow with a write of its own.
 *
 * That is not a hazard someone imagined. It is what `_platform/prisma`'s build script did: `rm -rf ./generated
 * ./dist ./.cache` ahead of `prisma generate`. Run on the main tree by `turbo run build` — the push gate's third
 * tier, the image-tree prep, an owner typing `pnpm build` — it replaced the lowerdir of every live agent
 * worktree's `_platform/prisma/generated` overlay at once. Each of those turns was then holding a directory with
 * a freshly generated `client.ts` in it that `readdir` reported as empty, so the `"include": ["./generated/**"]`
 * glob in that package's tsconfig matched nothing and the declarations emit died with
 *
 *     _platform/prisma/client.ts(1,15): error TS6307: File '.../generated/client.ts' is not listed within the
 *     file list of project '.../_platform/prisma/tsconfig.json'
 *
 * on the turn-ending check of every conversation, whatever the turn had actually changed. A gate that is red for
 * a reason no turn caused is the failure mode docs/ci-failure-audit.md exists to hunt, and it teaches everyone
 * reading it that a red check is background noise.
 *
 * WHY THE RULE IS ABOUT THE MOUNT ROOT AND NOT ABOUT EVERY DIRECTORY UNDER IT. `prisma generate` does the same
 * remove-and-recreate to `generated/models` and `generated/internal` on every run, and no rule here could stop
 * it — that is a third-party generator's business. It does not have to be stopped: a turn's own generate rmdirs
 * those same subdirectories through the MERGED view first, which leaves an opaque upper directory the stale
 * lower can no longer reach. Only the mount root has no such repair, which is exactly where this rule sits.
 *
 * So: EMPTY A MIRRORED DIRECTORY, NEVER REPLACE IT. _tools/scripts/build/clean-outputs.mjs is what does that, and
 * _tools/checks/mirror-roots.mjs refuses the shape wherever a shell command in this repository spells it.
 *
 * Hand-written JavaScript rather than compiled TypeScript for the reason node.mjs gives: the checkout gate that
 * enforces this imports it by relative path from a clone that has never installed, and the daemon imports the
 * same file as `@intentic/constants/mirror-roots`. */

// The directory NAMES a turn overlays, discovered by name wherever they appear in the tree (isolation.ts walks
// for them). Caches are deliberately absent, and that absence is load-bearing: see the MIRRORED_DIRS comment in
// isolation.ts for why a mirrored `.cache` would hand a turn the main checkout's idea of what its dist was
// built from. Nothing mounts a `.cache`, so it is free to be removed outright, and the build scripts fixed for
// this still do exactly that to theirs.
export const MIRRORED_DIRS = new Set(["node_modules", "dist", "generated"]);

// A path's last segment, with quotes and trailing slashes taken off. `"$PKG/dist"` and `./generated/` both name
// a mirror root; `node_modules/.pnpm/onnxruntime-web@*` does not, and neither does `dist/*`, which removes the
// CONTENTS and leaves the inode alone.
const lastSegment = (token) => {
    const bare = token.replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
    return bare.slice(bare.lastIndexOf("/") + 1);
};

/* One shell word at a time, quotes kept so `lastSegment` can strip them and a quoted `'{}'` still reads as the
 * find placeholder it is. Not a shell parser and not trying to be: what this has to recognize is a removal
 * someone WROTE, and every one of those in this repository is a plain sequence of words. */
const tokenize = (segment) => segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];

/* The verbs that can remove a directory, and the words that may stand in front of one. `docker rm -f <name>`
 * removes a container and `find … -exec rm -rf {} +` removes files, so the preceding word is what tells them
 * apart: a removal is a COMMAND here, or the thing an exec/sudo/xargs runs, never an argument to something
 * else. (It costs nothing to be wrong about `docker rm` anyway — it is never recursive — but a check that
 * reports a container by name would be read as noise, and a noisy gate gets switched off.) */
const REMOVERS = new Set(["rm", "rmdir", "rimraf"]);
const RUNNERS = new Set(["exec", "-exec", "-execdir", "sudo", "xargs", "then", "do", "else", "{", "(", "npx", "pnpm", "bunx", "yarn"]);
// `-rf`, `-fr`, `-Rf`, `-r`, `--recursive`. A non-recursive `rm` cannot take a directory at all, so it can
// never be the operation this is about: `rm -f dist.zip` is fine and must stay unreported. (It is also what
// keeps `pnpm rm <package>`, an uninstall, out of this: nothing there is recursive.)
const RECURSIVE = /^(?:--recursive$|-[a-zA-Z]*[rR])/;
// Where a `find -exec` command ends. Everything after it belongs to the find again.
const EXEC_END = new Set([";", "\\;", "+"]);
const PLACEHOLDER = /^['"]?\{\}['"]?$/;
// The find predicates that NAME what will be removed, and the one that makes a find safe: `-mindepth 1` never
// yields the directory it started from, which is precisely how you empty a tree without replacing its root.
const NAME_PREDICATES = new Set(["-name", "-iname", "-path", "-wholename", "-ipath"]);

/* WHICH MIRROR ROOTS A SHELL COMMAND WOULD REPLACE, as the operands were written, so a report can quote them.
 *
 * Two shapes, because those are the two ways this repository has ever spelled it:
 *   · a literal removal — `rm -rf ./generated ./dist ./.cache`, `rm -rf "$PKG/dist"`
 *   · a find that removes what it names — `find . \( -name 'node_modules' -o -name 'dist' \) -prune -exec rm
 *     -rf '{}' +`, where the removal's own operand is a placeholder and the find's predicates say what it hits.
 *
 * Split on the separators that end one command, so `a && rm -rf dist` is two commands and a `find … -exec rm …`
 * stays one: only inside a single command do a find's predicates describe that removal's operands.
 *
 * A FIND IS READ WHOLE, AND THAT ROUNDS TOWARDS REFUSING. `find . -name node_modules -prune -o -name dist
 * -prune -exec rm -rf {} +` removes only the second name; the first is pruned past. Telling them apart means
 * implementing find's expression grammar — `-o`, `-a`, `-prune` and their precedence — for a distinction that
 * changes nothing about the answer, since the safe rewrite is the same either way and neither name may be
 * REMOVED by a command running in the checkout. So every `-name` in a removing find is reported, and the fix
 * for a false one is the fix for a true one. */
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
        // `find -delete` removes what the predicates name, with no `rm` anywhere in the line to notice.
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
                // A `{}` is the find's placeholder: what it stands for is whatever the predicates named.
                const targets = PLACEHOLDER.test(operand) ? named : [operand];
                found.push(...targets.filter((target) => MIRRORED_DIRS.has(lastSegment(target))));
            }
        }
    }
    return [...new Set(found)];
};
