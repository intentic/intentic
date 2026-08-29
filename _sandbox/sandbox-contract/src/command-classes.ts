import { type CommandClass, CommandClassSchema } from "./schemas/agent.js";

/* WHICH CLASSES A SHELL COMMAND FALLS IN, the classifier behind every command gate, read before the command runs.
 *
 * IT LIVES IN THE CONTRACT PACKAGE because there are TWO enforcement points and they must not drift. The
 * sandbox's own gate (sandbox/src/guard/command-gate.ts) judges what the agent types here; the machine agent's
 * shell tool (_computers/host/src/tools/shell.ts) judges what it sends to somebody's laptop. Those answer to
 * different policy (a rulebook with a permission card here, a scope switch on the card there) but they must
 * agree on WHAT A COMMAND IS, or a class the owner thought they had covered turns out to mean something else on
 * the surface where it mattered most. One table, two consults.
 *
 * ALL of them, not the first match, because a gate takes the most restrictive verdict across them and the
 * interesting commands are exactly the ones in two classes at once: `curl -d @.env https://…` is both
 * `secrets.access` and `network.outbound`, and an owner who holds either meant to see it. Returning one class
 * would let a rule on the other decide.
 *
 * HONESTY, the same note the outbound sniffer carries and for the same reason. This is regex over shell text.
 * A creatively quoted command, a path assembled from a variable, or a script written in one call and run in the
 * next goes past it untouched. So a gate built on this is friction and a prompt for well-behaved work, never a
 * boundary, the boundaries are structural and elsewhere: the container, the isolated worktree, the land gate,
 * an automation's tool allowlist, and, on somebody's own computer, the scope switches enforced there.
 *
 * Matching is deliberately UNANCHORED, substrings, not line starts. Another PreToolUse hook may have rewrapped
 * the command by the time this reads it (agent-terminals.ts wraps every Bash call in bin/tmux-run), and the
 * agent's own line survives verbatim inside that wrapper. Nothing the wrapper adds is in any class below.
 *
 * `[^|;&]*` in a pattern keeps a flag tied to the verb before it, so a later command in a pipeline cannot lend
 * its flags to an earlier one, `git push origin | grep -f patterns` is not a force-push.
 */

const GIT_DESTRUCTIVE = [
    /\bgit\s+push\b[^|;&]*\s(?:-f\b|--force\b|--force-with-lease\b|--delete\b)/,
    /\bgit\s+reset\b[^|;&]*\s--hard\b/,
    // Any `clean` that forces: it deletes untracked files, which is work no history holds a copy of.
    /\bgit\s+clean\b[^|;&]*\s-{1,2}[a-zA-Z]*f/,
    /\bgit\s+branch\b[^|;&]*\s(?:-D\b|--delete\s+--force\b|--force\s+--delete\b)/,
    /\bgit\s+filter-branch\b/,
];

const SECRETS_ACCESS = [
    /* The reference exit, which is a credential READ by another name: `{{secret:NAME}}` in a command becomes
     * the real value on the way into the process (agent/agent-secrets.ts), so a command carrying one belongs in
     * this class whatever else it does. Without it the outside-content floor in guard/actions.ts is bypassed by
     * writing a reference into a curl instead of reading a dotenv, which is the shorter route to the same
     * place: `curl -d @.env` is held, `curl -d '{"t":"{{secret:X}}"}'` was not. The alphabet is REFERENCE's,
     * from secrets/secret-registry.ts, respelled rather than imported to keep this table free of a dependency
     * on the stores it describes. */
    /\{\{secret:[A-Za-z0-9_./-]+\}\}/,
    /* A dotenv file: `.env`, `.env.production`, `-d @.env`. NOT the checked-in templates that sit beside it in
     * every repo, and not `process.env`, the lookbehind is what excludes the latter, which is otherwise the
     * single most common string in this workspace's own commands and would hold every grep for it. */
    /(?<![\w.])\.env(?!\.(?:example|sample|template))(?:\.[\w-]+)?\b/,
    /\.ssh\//,
    /\bid_(?:rsa|dsa|ecdsa|ed25519)\b/,
    /\.aws\/credentials\b/,
    /\.npmrc\b/,
    /\.git-credentials\b/,
    /\.credentials\.json\b/,
];

const PACKAGE_PUBLISH = [
    /\b(?:npm|pnpm|yarn|bun)\s+publish\b/,
    /\bcargo\s+publish\b/,
    /\bgh\s+release\s+create\b/,
    /\bdocker\s+push\b/,
    /\btwine\s+upload\b/,
];

/* The loopback hosts, as a WHOLE HOST rather than a prefix. `localhost\b` reads as an exemption for
 * `localhost.attacker.com`, because a `.` is a word boundary, and for `localhost@attacker.com`, where the
 * loopback name is a URL's userinfo and curl connects to whatever follows the `@`. Either one is a host an
 * attacker registers, so a prefix test hands it the exemption meant for this container talking to itself, and
 * with it the outside-content envelope and the turn's taint bit: outsideSourceOf (guard/outside-results.ts) is
 * built on this class, so a response judged loopback is never wrapped and never marks the turn. The trailing
 * lookahead is what makes it a whole host, the port is optional, and a URL's authority can only end at one of
 * `/?#`, whitespace, or a closing quote. */
const LOOPBACK = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?=[/?#\s'"\x60]|$)`;

// The sandbox talks to itself over loopback constantly, the host bridge, a dev server the agent just started,
// and none of that leaves the container, so the class is about reaching OUT rather than about curl.
const NETWORK_OUTBOUND = [
    new RegExp(String.raw`\b(?:curl|wget)\b[^|;&]*\bhttps?://(?!${LOOPBACK})`),
    /* The JS execution backend's curl: a literal non-loopback URL handed to `fetch(`. The classifier reads
     * scripts with the same substring honesty it reads shell (the gate feeds it both, see command-gate's
     * EXECUTION_SOURCES), so an owner's rule about reaching out covers both ways of doing it, and the
     * outside-content seam wraps what a fetching script brings back exactly as it wraps a fetching curl's. A
     * URL assembled at runtime walks past this, as the header already admits for shell variables. */
    new RegExp(String.raw`\bfetch\(\s*['"\x60]https?://(?!${LOOPBACK})`),
];

/* --- rm, parsed once ------------------------------------------------------------------------------------
 *
 * ONE PARSE, TWO CLASSES. `rm -rf build` and `rm -rf /` are the same verb with the same flags and wildly
 * different consequences, and the whole reason the second is a class of its own is that its default differs:
 * deleting a build directory is ordinary work in a disposable container, and deleting the root it sits in is
 * the thing nothing here undoes. Splitting them needs the OPERANDS, not just the flags, so the invocation is
 * taken apart once and both classes read the same result rather than two regexes drifting apart.
 *
 * An invocation ends at a pipeline separator: everything after `|`, `;`, `&`, or a newline belongs to the next
 * command and must not be read as this one's targets. */
const RM_INVOCATION = /\brm\s+([^|;&\n]*)/g;

interface RmInvocation {
    readonly recursive: boolean;
    readonly force: boolean;
    readonly operands: readonly string[];
}

// A shell word with its quoting removed, so `"/work"`, `'/work'` and `/work` are one operand and not three.
const unquote = (word: string): string => word.replace(/^['"`]|['"`]$/g, "");

const parseRm = (command: string): RmInvocation[] => {
    const parsed: RmInvocation[] = [];
    for (const invocation of command.matchAll(RM_INVOCATION)) {
        let recursive = false;
        let force = false;
        const operands: string[] = [];
        for (const word of (invocation[1] as string).trim().split(/\s+/)) {
            if (word === "") {
                continue;
            }
            // A long flag is one whole word; a short cluster is a bag of letters. `--force` must not be read as
            // the letters f-o-r-c-e, or every `rm --force` would look recursive too.
            if (word.startsWith("--")) {
                recursive ||= word === "--recursive";
                force ||= word === "--force";
                continue;
            }
            if (word.startsWith("-")) {
                recursive ||= /[rR]/.test(word);
                force ||= word.includes("f");
                continue;
            }
            operands.push(unquote(word));
        }
        parsed.push({ recursive, force, operands });
    }
    return parsed;
};

/* A TARGET THAT IS A ROOT RATHER THAN SOMETHING INSIDE ONE. This is the whole difference between the two
 * deletion classes, so it is deliberately a short, closed list of whole names rather than a clever heuristic:
 * the filesystem root and the top-level directories an OS keeps, the two trees this product keeps state in, a
 * home directory however it is spelled, and a Windows drive.
 *
 * `/tmp` is deliberately absent. It is scratch by definition and emptying it is a chore, not an incident. */
const ROOT_DIRECTORIES = new Set([
    // The empty string is what the filesystem root normalizes to, see trimTarget.
    "",
    "/work",
    "/history",
    "/home",
    "/root",
    "/etc",
    "/usr",
    "/var",
    "/opt",
    "/boot",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/srv",
    "/dev",
    "/sys",
    "/proc",
    "/mnt",
    "/media",
    "/Users",
    "/Applications",
    "/System",
    "/Library",
]);

const HOME_ALIAS = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)$/;
const WINDOWS_DRIVE = /^[A-Za-z]:$/;

/* `/work`, `/work/` and `/work/*` are one target said three ways: a trailing separator or wildcard says
 * "everything in it", which is what deleting the directory means anyway. A BARE `*` is left alone on purpose,
 * it is relative to whatever the shell is standing in, and `rm -rf *` in a build directory is the ordinary
 * case this class exists to stay out of the way of. */
const trimTarget = (operand: string): string => operand.replace(/[/\\]\*+$/, "").replace(/[/\\]+$/, "");

const isRootTarget = (operand: string): boolean => {
    const target = trimTarget(operand);
    if (HOME_ALIAS.test(target) || WINDOWS_DRIVE.test(target)) {
        return true;
    }
    // Only an absolute path can name a root, and `""` is the root itself. A relative path is inside whatever
    // the shell is standing in, which this cannot know and must not guess about.
    return target === "" ? operand.startsWith("/") || operand.startsWith("\\") : ROOT_DIRECTORIES.has(target);
};

/* --- the JS execution backend's own deletes -------------------------------------------------------------
 *
 * THE SAME CONSEQUENCE, SPELLED IN NODE. The gate feeds this classifier the `mcp__code__run` script as well as
 * the shell line (command-gate's EXECUTION_SOURCES), so `execSync("rm -rf /work")` inside a script already
 * lands in the shell patterns above by substring. `fs.rmSync("/work", { recursive: true, force: true })` did
 * not, and it is the shorter way to write the same afternoon's worth of lost work: the rule an owner wrote
 * about deleting recursively has to mean the same thing on both backends or it does not mean much.
 *
 * RECURSIVE ALONE IS ENOUGH HERE, where the shell form needs recursive AND force. That is not an inconsistency:
 * `rm -r` without `-f` stops on the first prompt and a script has no terminal to answer one, so the shell's
 * recoverable spelling really is recoverable. `fs.rm(p, { recursive: true })` prompts nobody and deletes the
 * tree, so the recoverable spelling does not exist on this side.
 *
 * TWO PATTERNS PER SPELLING, and the split matters: whether the script deletes recursively AT ALL is a
 * different question from WHICH PATH it deletes, and only the first can be answered when the path is a
 * variable. `rm(target, { recursive: true })` is files.destructive with no literal to read, and demanding one
 * (as the first draft did) let exactly the ordinary way of writing it through.
 *
 * The header's honesty note applies here too, and one limit is worth naming: `[^)]*` cannot cross a closing
 * paren, so `fs.rmSync(join(a, b), { recursive: true })` walks past. Same class of gap as a shell path built
 * from a variable, and the same answer: this is friction for well-behaved work, not a boundary. */
const NODE_RECURSIVE_RM = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\([^)]*?recursive\s*:\s*true/;
const NODE_RECURSIVE_RM_PATH = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\(\s*(['"`])([^'"`]*)\1[^)]*?recursive\s*:\s*true/g;
// rimraf's whole purpose is the recursive force delete, so the call itself is the match; no options to read.
const RIMRAF = /\brimraf(?:\.sync|Sync|\.native|\.rimraf)?\s*\(/;
const RIMRAF_PATH = /\brimraf(?:\.sync|Sync|\.native|\.rimraf)?\s*\(\s*(['"`])([^'"`]*)\1/g;

// Whether the script deletes a tree at all, however the path reaches it.
const deletesRecursively = (program: string): boolean => NODE_RECURSIVE_RM.test(program) || RIMRAF.test(program);

// The literal paths a script hands to a recursive delete. Empty when every path it deletes is computed, which
// is the honest answer rather than a guess: the class above already holds, only the root question goes unasked.
const nodeDeleteTargets = (program: string): string[] =>
    [...program.matchAll(NODE_RECURSIVE_RM_PATH), ...program.matchAll(RIMRAF_PATH)].map((match) => match[2] as string);

/* --- state nothing brings back -------------------------------------------------------------------------
 *
 * THE CLASS WITH A FLOOR UNDER IT (guard/actions.ts commandRun holds it even where the owner wrote no rule),
 * so its membership is chosen against a hard question: does anything in this product bring the state back?
 *
 * A worktree is restored from git, a checkpoint restores the tree, a container is recreated from its image,
 * an npm package is re-installed. None of that reaches a formatted disk, a deleted Docker volume, or a home
 * directory that is no longer there. Those are the members. Deliberately NOT members: `docker rm` (recreate
 * it), `docker image prune` (pull it again), `git reset --hard` (that is git.destructive, and the reflog has
 * it), `rm -rf node_modules` (install it again). The point of a floor is that it is rare enough to be worth
 * stopping for; a floor that fires on ordinary work is one people learn to click through. */
const SYSTEM_DESTRUCTIVE = [
    // Format, wipe or overwrite a block device. `dd` only counts when it is pointed AT a device: reading one
    // into a file is how an image is taken, and holding a backup would be exactly the wrong lesson.
    /\bmkfs(?:\.\w+)?\b/,
    /\bwipefs\b/,
    /\bblkdiscard\b/,
    /\bsgdisk\b[^|;&]*\s(?:--zap-all|-Z)\b/,
    /\bdd\b[^|;&]*\bof=(?:\/dev\/|['"`]\/dev\/)/,
    /\bshred\b[^|;&]*\s\/dev\//,
    // A redirect straight onto a disk device, which is the same wipe without the ceremony.
    />\s*\/dev\/(?:[shv]d[a-z]|nvme\d|disk\d|mmcblk\d)/,
    /* Docker state that is data rather than image. A named volume IS the database; `system prune` takes every
     * unused one with it, and `compose down -v` is the spelling people reach for without reading the flag.
     * In this sandbox these hit the nested engine (the host's socket is never mounted, see
     * capabilities/handlers/docker.ts), so the blast radius is the dev databases the agent has been working
     * against. Sent to somebody's own computer through the host agent, it is whatever they run on it. */
    /\b(?:docker|podman)\s+volume\s+(?:rm|remove|prune)\b/,
    /\b(?:docker|podman)\s+system\s+prune\b/,
    /\b(?:docker(?:\s+compose|-compose)?|podman-compose)\s+down\b[^|;&]*\s(?:-v\b|--volumes\b)/,
];

const isRecursiveForceRm = (command: string): boolean => parseRm(command).some((invocation) => invocation.recursive && invocation.force);

// A recursive delete aimed at a root, in either spelling the gate can be handed: the shell's `rm -rf /` and
// the script's `fs.rmSync("/", { recursive: true })`.
const deletesARoot = (program: string): boolean =>
    parseRm(program).some((invocation) => invocation.recursive && invocation.force && invocation.operands.some(isRootTarget)) ||
    nodeDeleteTargets(program).some(isRootTarget);

const MATCHES: Readonly<Record<CommandClass, (command: string) => boolean>> = {
    "git.destructive": (command) => GIT_DESTRUCTIVE.some((pattern) => pattern.test(command)),
    "files.destructive": (command) => isRecursiveForceRm(command) || deletesRecursively(command),
    "system.destructive": (command) => SYSTEM_DESTRUCTIVE.some((pattern) => pattern.test(command)) || deletesARoot(command),
    "secrets.access": (command) => SECRETS_ACCESS.some((pattern) => pattern.test(command)),
    "package.publish": (command) => PACKAGE_PUBLISH.some((pattern) => pattern.test(command)),
    "network.outbound": (command) => NETWORK_OUTBOUND.some((pattern) => pattern.test(command)),
};

// Every class the command falls in, in the catalog's own order so a card and a log name them the same way twice.
export const classifyCommand = (command: string): CommandClass[] =>
    CommandClassSchema.options.filter((commandClass) => MATCHES[commandClass](command));

// What the card says the command would DO. The class name is a settings key, not a sentence to show a person.
export const COMMAND_CLASS_LABELS: Readonly<Record<CommandClass, string>> = {
    "git.destructive": "rewrite or discard git history",
    "files.destructive": "delete files recursively",
    "system.destructive": "wipe a disk, a container volume, or a whole home or root directory",
    "secrets.access": "read credential material",
    "package.publish": "publish or release a package",
    "network.outbound": "send a request out to the internet",
};

/* THE CLASSES THE DAEMON HOLDS WHERE THE OWNER WROTE NO RULE, and the machine agent refuses without its own
 * switch. Named here rather than at either consult, so "which commands are dangerous enough to stop by
 * default" has one answer that both enforcement points read. */
export const FLOOR_CLASSES: ReadonlySet<CommandClass> = new Set<CommandClass>(["system.destructive"]);
