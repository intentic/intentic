import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { type CommandClass, CommandClassSchema, type CommandLocus } from "../schemas/agent.js";
import { inertRegions, isLive } from "../text/shell-regions.js";

// Classifies a shell command, shared by the sandbox gate and the machine agent's shell tool so they can't drift on what
// a class means. A match now only means a judge should look, not a verdict, so tables should be over-inclusive, except
// the hard-rule classes, which read `live` instead.

// A half-open slice of the command text, in UTF-16 code units, the offsets a renderer slices with.
export interface CommandSpan {
    readonly start: number;
    readonly end: number;
}

// One class the command fell in, and the fragments that put it there. `spans` is never empty: a class with nothing to
// point at is not reported.
export interface CommandMatch {
    readonly commandClass: CommandClass;
    readonly spans: readonly CommandSpan[];
    // Whether a shell would run the fragment, vs text; only the hard rule ever reads this bit.
    readonly live: boolean;
}

// What the caller can check that the patterns cannot. Optional everywhere: absent means every table answers from the
// command text alone.
export interface CommandContext {
    // Where this command would run, with no default: half this catalog means something different per machine.
    readonly locus: CommandLocus;
    // true/false/undefined for holding a credential; only false drops a class, undefined still counts as a hit.
    readonly holdsSecret?: (path: string) => boolean | undefined;
}

// The `g` twin of a table's patterns, built once: the tables stay flag-free since a surviving lastIndex is how a shared
// regex starts skipping matches, and `test` (the verdict path) wants that. matchAll demands `g`.
const globally = (patterns: readonly RegExp[]): readonly RegExp[] => patterns.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));

// Every occurrence of every pattern, as spans over `command`. The whole match, not a capture group: a pattern spans the
// consequence (`git push … --force`), and a group would leave the verb it belongs to unmarked.
const spansOf = (patterns: readonly RegExp[], command: string): CommandSpan[] =>
    patterns.flatMap((pattern) => [...command.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length })));

// Sorted, with overlaps folded (not adjacency: touching spans from different fragments stay two marks). Exported since
// a caller marking several classes at once must also fold overlap across classes, not just within one.
export const mergeSpans = (spans: readonly CommandSpan[]): CommandSpan[] => {
    const merged: CommandSpan[] = [];
    for (const span of [...spans].sort((left, right) => left.start - right.start || left.end - right.end)) {
        const last = merged.at(-1);
        if (last !== undefined && span.start < last.end) {
            merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, span.end) };
            continue;
        }
        merged.push(span);
    }
    return merged;
};

const GIT_DESTRUCTIVE = [
    /\bgit\s+push\b[^|;&]*\s(?:-f\b|--force\b|--force-with-lease\b|--delete\b)/,
    /\bgit\s+reset\b[^|;&]*\s--hard\b/,
    // Any `clean` that forces: it deletes untracked files, which is work no history holds a copy of.
    /\bgit\s+clean\b[^|;&]*\s-{1,2}[a-zA-Z]*f/,
    /\bgit\s+branch\b[^|;&]*\s(?:-D\b|--delete\s+--force\b|--force\s+--delete\b)/,
    /\bgit\s+filter-branch\b/,
];

// The credential is IN the command, not in a file; there is nothing for a filesystem to fact-check here.
const SECRET_REFERENCES = [/\{\{secret:[A-Za-z0-9_./-]+\}\}/];

// A path that usually holds a credential, a guess about a FILE, so every entry here is subject to holdsSecret.
// The directory in front of a filename, so a pattern spans the whole path, not just the file inside it.
const LEADING_PATH = String.raw`[\w~$.{}/\\-]*`;

const CREDENTIAL_PATHS = [
    // A dotenv file, not the checked-in templates beside it and not `process.env` (excluded by the lookbehind).
    /(?<![\w.])\.env(?!\.(?:example|sample|template))(?:\.[\w-]+)?\b/,
    // The ssh directory and what's under it, except the three public-by-design members (.pub, known_hosts, config).
    /\.ssh(?!\w)(?!\/(?:known_hosts|config|authorized_keys|environment)(?!\w))(?!\/[\w.-]*\.pub(?!\w))(?:\/[\w.\-/]*)?/,
    // A private key by its conventional name; `.pub` beside it is the public half and is not this.
    /\bid_(?:rsa|dsa|ecdsa|ed25519)\b(?!\.pub\b)/,
    new RegExp(String.raw`${LEADING_PATH}\.aws/credentials\b`),
    // An npmrc, but not the checked-in template beside it, the same exclusion `.env` has.
    new RegExp(String.raw`${LEADING_PATH}\.npmrc(?!\.(?:example|sample|template))\b`),
    new RegExp(String.raw`${LEADING_PATH}\.git-credentials\b`),
    new RegExp(String.raw`${LEADING_PATH}\.credentials\.json\b`),
];

const PACKAGE_PUBLISH = [
    /\b(?:npm|pnpm|yarn|bun)\s+publish\b/,
    /\bcargo\s+publish\b/,
    /\bgh\s+release\s+create\b/,
    /\bdocker\s+push\b/,
    /\btwine\s+upload\b/,
];

// The loopback hosts, as a whole host not a prefix: localhost.attacker.com must not inherit the exemption.
const LOOPBACK = String.raw`(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?=[/?#\s'"\x60]|$)`;

// Loopback traffic never leaves the container, so this class means reaching OUT, not curl specifically.
const NETWORK_OUTBOUND = [
    new RegExp(String.raw`\b(?:curl|wget)\b[^|;&]*\bhttps?://(?!${LOOPBACK})`),
    // The JS backend's own curl: a literal non-loopback URL handed to fetch(); a runtime-built URL walks past it.
    new RegExp(String.raw`\bfetch\(\s*['"\x60]https?://(?!${LOOPBACK})`),
];

// One parse feeds both rm classes, since only the operand tells build-dir from root apart.
const RM_INVOCATION = /\brm\s+([^|;&\n]*)/g;

interface RmInvocation {
    readonly recursive: boolean;
    readonly force: boolean;
    readonly operands: readonly string[];
    // Where this invocation sits, verb through last operand, so a card can point at just this delete.
    readonly span: CommandSpan;
}

// A shell word with its quoting removed, so "/work", '/work' and /work are one operand, not three.
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
            // A long flag is one whole word; a short cluster is a bag of letters, so --force isn't read as f-o-r-c-e.
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
        parsed.push({ recursive, force, operands, span: { start: invocation.index, end: invocation.index + invocation[0].trimEnd().length } });
    }
    return parsed;
};

// A target that is a root vs inside one: a closed list per locus, since "root" differs per machine.

// Two entries: the root itself, and /history, since no other conversation's data is recoverable here.
const SANDBOX_ROOTS = new Set(["", HISTORY_ROOT]);

// The full list: nothing on a real machine is rebuilt from an image, so every top-level OS directory counts.
const DEVICE_ROOTS = new Set([
    "",
    WORKSPACE_ROOT,
    HISTORY_ROOT,
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

const rootsAt = (locus: CommandLocus): ReadonlySet<string> => (locus === "sandbox" ? SANDBOX_ROOTS : DEVICE_ROOTS);

const HOME_ALIAS = /^(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%)$/;
const WINDOWS_DRIVE = /^[A-Za-z]:$/;

// A trailing separator or wildcard means "everything in it"; a bare * is left alone (relative to cwd).
const trimTarget = (operand: string): string => operand.replace(/[/\\]\*+$/, "").replace(/[/\\]+$/, "");

const isRootTarget = (operand: string, locus: CommandLocus): boolean => {
    const target = trimTarget(operand);
    // Home directory/Windows drive are roots only on a device: the sandbox's ~ is scratch, rebuilt with the image.
    if (HOME_ALIAS.test(target) || WINDOWS_DRIVE.test(target)) {
        return locus === "device";
    }
    // Only an absolute path can be a root; a relative path is relative to a cwd this cannot know or guess.
    return target === "" ? operand.startsWith("/") || operand.startsWith("\\") : rootsAt(locus).has(target);
};

// Node spellings of the same deletes; recursive alone is enough, since a script has no prompt to interrupt it.
const NODE_RECURSIVE_RM = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\([^)]*?recursive\s*:\s*true/;
const NODE_RECURSIVE_RM_PATH = /\b(?:rm|rmSync|rmdir|rmdirSync)\s*\(\s*(['"`])([^'"`]*)\1[^)]*?recursive\s*:\s*true/g;
// rimraf's whole purpose is the recursive force delete, so the call itself is the match; no options to read.
const RIMRAF = /\brimraf(?:\.sync|Sync|\.native|\.rimraf)?\s*\(/;
const RIMRAF_PATH = /\brimraf(?:\.sync|Sync|\.native|\.rimraf)?\s*\(\s*(['"`])([^'"`]*)\1/g;

// Where a script deletes a tree, however the path reaches it. Empty means it does not.
const recursiveDeletes = (program: string): CommandSpan[] => spansOf(globally([NODE_RECURSIVE_RM, RIMRAF]), program);

// The literal paths a script hands to a recursive delete, each with its call. Empty when every path is computed, the
// honest answer: the class above still holds, only the root question goes unasked.
const nodeDeleteTargets = (program: string): { readonly target: string; readonly span: CommandSpan }[] =>
    [...program.matchAll(NODE_RECURSIVE_RM_PATH), ...program.matchAll(RIMRAF_PATH)].map((match) => ({
        target: match[2] as string,
        span: { start: match.index, end: match.index + match[0].length },
    }));

// Membership: does anything here bring the state back? A worktree, checkpoint or image restore doesn't count.
// A block device wiped or overwritten, independent of locus; dd only counts writing to it, not reading one.
const BLOCK_DEVICE = [
    /\bmkfs(?:\.\w+)?\b/,
    /\bwipefs\b/,
    /\bblkdiscard\b/,
    /\bsgdisk\b[^|;&]*\s(?:--zap-all|-Z)\b/,
    /\bdd\b[^|;&]*\bof=(?:\/dev\/|['"`]\/dev\/)/,
    /\bshred\b[^|;&]*\s\/dev\//,
    // A redirect straight onto a disk device: the same wipe without the ceremony.
    />\s*\/dev\/(?:[shv]d[a-z]|nvme\d|disk\d|mmcblk\d)/,
];

// Container data, not image: ordinary here (the agent's own nested volumes); still hard-ruled on a real device.
const CONTAINER_STATE = [
    /\b(?:docker|podman)\s+volume\s+(?:rm|remove|prune)\b/,
    /\b(?:docker|podman)\s+system\s+prune\b/,
    /\b(?:docker(?:\s+compose|-compose)?|podman-compose)\s+down\b[^|;&]*\s(?:-v\b|--volumes\b)/,
];

const recursiveForceRms = (command: string): CommandSpan[] =>
    parseRm(command)
        .filter((invocation) => invocation.recursive && invocation.force)
        .map((invocation) => invocation.span);

// A recursive delete aimed at a root, in either spelling the gate is handed (shell or script). Which targets count as
// roots is the locus's answer.
const rootDeletes = (program: string, locus: CommandLocus): CommandSpan[] => [
    ...parseRm(program)
        .filter((invocation) => invocation.recursive && invocation.force && invocation.operands.some((operand) => isRootTarget(operand, locus)))
        .map((invocation) => invocation.span),
    ...nodeDeleteTargets(program)
        .filter((delete_) => isRootTarget(delete_.target, locus))
        .map((delete_) => delete_.span),
];

// The g twins, built once at load: a card is minted per command held, classify runs per command typed.
const GIT_DESTRUCTIVE_G = globally(GIT_DESTRUCTIVE);
const SECRET_REFERENCES_G = globally(SECRET_REFERENCES);
const CREDENTIAL_PATHS_G = globally(CREDENTIAL_PATHS);
const PACKAGE_PUBLISH_G = globally(PACKAGE_PUBLISH);
const NETWORK_OUTBOUND_G = globally(NETWORK_OUTBOUND);
const BLOCK_DEVICE_G = globally(BLOCK_DEVICE);
const CONTAINER_STATE_G = globally(CONTAINER_STATE);

// The word a matched fragment sits in, so the fact-check asks about the file the command would actually open, not the
// suffix that fired. A wrong guess just resolves to an unreadable path, the old behaviour, not a hole.
const WORD_EDGE = /[\s'"`;|&()]/;
const enclosingPath = (command: string, span: CommandSpan): string => {
    let start = span.start;
    while (start > 0 && !WORD_EDGE.test(command[start - 1] as string)) {
        start -= 1;
    }
    let end = span.end;
    while (end < command.length && !WORD_EDGE.test(command[end] as string)) {
        end += 1;
    }
    return command
        .slice(start, end)
        .replace(/^-{1,2}[\w-]+=/, "")
        .replace(/^[@<>=]+/, "");
};

// Tells a search pattern from a real path before trusting the table's filename guess: an escaped dot, a character
// class, or a class escape marks a regex, not a path, except on a Windows path spelled the same way.
const CHARACTER_CLASS = /\[[^\]]*\]/;
const CLASS_ESCAPE = /\\[wdsbWDSB](?!\w)/;
const ESCAPED_DOT = /\\\./;
const PATH_SEPARATOR = /\\\w/;
const namesAPattern = (word: string): boolean =>
    CHARACTER_CLASS.test(word) || CLASS_ESCAPE.test(word) || (ESCAPED_DOT.test(word) && !PATH_SEPARATOR.test(word));

// Every secret reference plus every credential-shaped path the context didn't positively clear. Compared against
// `false`, not `true`: an `undefined` (could not check) must still count as a hit.
const credentialReads = (command: string, context: CommandContext): CommandSpan[] => [
    ...spansOf(SECRET_REFERENCES_G, command),
    ...spansOf(CREDENTIAL_PATHS_G, command).filter((span) => {
        const word = enclosingPath(command, span);
        return !namesAPattern(word) && context.holdsSecret?.(word) !== false;
    }),
];

// One function per class; empty means the command is not in it, so membership and evidence are the same walk.
const MATCHES: Readonly<Record<CommandClass, (command: string, context: CommandContext) => CommandSpan[]>> = {
    "git.destructive": (command) => spansOf(GIT_DESTRUCTIVE_G, command),
    "files.destructive": (command) => [...recursiveForceRms(command), ...recursiveDeletes(command)],
    "system.destructive": (command, context) => [...spansOf(BLOCK_DEVICE_G, command), ...rootDeletes(command, context.locus)],
    "container.state": (command) => spansOf(CONTAINER_STATE_G, command),
    "secrets.access": credentialReads,
    "package.publish": (command) => spansOf(PACKAGE_PUBLISH_G, command),
    "network.outbound": (command) => spansOf(NETWORK_OUTBOUND_G, command),
};

// Every class the command falls in, with its fragments, in the catalog's own order. `context` is now required: its
// locus decides what half the catalog means, and the inert scan runs once, shared by every class.
export const matchCommand = (command: string, context: CommandContext): CommandMatch[] => {
    const regions = inertRegions(command);
    return CommandClassSchema.options.flatMap((commandClass) => {
        const spans = mergeSpans(MATCHES[commandClass](command, context));
        return spans.length === 0 ? [] : [{ commandClass, spans, live: spans.some((span) => isLive(span, regions)) }];
    });
};

// Every class the command falls in, for callers that only need a verdict (a rulebook consult, a scope switch).
export const classifyCommand = (command: string, context: CommandContext): CommandClass[] =>
    matchCommand(command, context).map((match) => match.commandClass);

// What the card says the command would do. The class name is a settings key, not a sentence to show a person.
export const COMMAND_CLASS_LABELS: Readonly<Record<CommandClass, string>> = {
    "git.destructive": "rewrite or discard git history",
    "files.destructive": "delete files recursively",
    "system.destructive": "wipe a disk, or delete a whole root directory",
    "container.state": "delete a container volume or the data in it",
    "secrets.access": "read credential material",
    "package.publish": "publish or release a package",
    "network.outbound": "send a request out to the internet",
};

// One fragment that fires a class, split so `code` is shell or script alone (highlightable) and `qualifier` carries
// what narrows it, in prose: a sentence with a command inside it is unhighlightable.
export interface CommandPattern {
    /** The literal a shell or a script would carry. Highlightable on its own; never a sentence. */
    readonly code: string;
    /** What narrows it, or the spellings folded into it. Prose, and rendered as prose. */
    readonly qualifier?: string;
}

// The catalog's patterns for the Safety page's human panel; one fragment per entry, not one line per regex.
export const COMMAND_CLASS_PATTERNS: Readonly<Record<CommandClass, readonly CommandPattern[]>> = {
    "git.destructive": [
        { code: "git push --force", qualifier: "also -f and --force-with-lease" },
        { code: "git push --delete" },
        { code: "git reset --hard" },
        { code: "git clean -f" },
        { code: "git branch -D" },
        { code: "git filter-branch" },
    ],
    "files.destructive": [
        { code: "rm -rf <path>" },
        { code: "fs.rm(<path>, { recursive: true })", qualifier: "also rmSync, rmdir, rmdirSync" },
        { code: "rimraf(<path>)" },
    ],
    "system.destructive": [
        { code: "mkfs" },
        { code: "wipefs" },
        { code: "blkdiscard" },
        { code: "sgdisk --zap-all" },
        { code: "dd of=/dev/…" },
        { code: "shred /dev/…" },
        { code: "> /dev/sda" },
        { code: "rm -rf /", qualifier: "only when the target is a root, listed below" },
    ],
    "container.state": [
        { code: "docker volume rm", qualifier: "also remove, prune, and podman for any of these" },
        { code: "docker system prune" },
        { code: "docker compose down -v" },
    ],
    "secrets.access": [
        { code: "{{secret:NAME}}", qualifier: "a stored secret, used in the command itself" },
        { code: ".env" },
        { code: ".ssh/*" },
        { code: "id_rsa" },
        { code: ".aws/credentials" },
        { code: ".npmrc" },
        { code: ".git-credentials" },
    ],
    "package.publish": [
        { code: "npm publish", qualifier: "also pnpm, yarn, bun" },
        { code: "cargo publish" },
        { code: "gh release create" },
        { code: "docker push" },
        { code: "twine upload" },
    ],
    "network.outbound": [
        { code: "curl https://…", qualifier: "also wget; loopback does not count" },
        { code: 'fetch("https://…")', qualifier: "in a script" },
    ],
};

// No verdict set lives here: which classes stop a command is now a policy question, answered elsewhere.
