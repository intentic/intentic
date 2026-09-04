import { type CommandClass, CommandClassSchema } from "./schemas/agent.js";

/* WHICH CLASSES A SHELL COMMAND FALLS IN, the classifier behind every command gate, read before the command runs.
 *
 * IT LIVES IN THE CONTRACT PACKAGE because there are TWO enforcement points and they must not drift. The
 * sandbox's own gate (sandbox/src/guard/command-gate.ts) judges what the agent types here; the machine agent's
 * shell tool (_computers/machine/src/computer/tools/shell.ts) judges what it sends to somebody's laptop. Those answer to
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
 * WHICH IS WHY THIS NO LONGER DECIDES ANYTHING. A match used to BE the verdict: whatever fired here became the
 * permission card, so `echo "rm -rf /"`, `rg 'rm -rf'` and an actual delete were one question with one answer.
 * Now a match only means A JUDGE SHOULD LOOK (safety-policy.ts argues the move at length, guard/command-gate.ts
 * implements it), and the judge reads the owner's written policy plus what the daemon knows about the turn.
 * That changes what these patterns should optimise for: being OVER-inclusive is close to free, because a false
 * positive now costs one model call rather than one interruption, and a miss still costs everything. Anyone
 * tuning a pattern below should widen rather than narrow it.
 *
 * Matching is deliberately UNANCHORED, substrings, not line starts. Another PreToolUse hook may have rewrapped
 * the command by the time this reads it (agent-terminals.ts wraps every Bash call in bin/tmux-run), and the
 * agent's own line survives verbatim inside that wrapper. Nothing the wrapper adds is in any class below.
 *
 * `[^|;&]*` in a pattern keeps a flag tied to the verb before it, so a later command in a pipeline cannot lend
 * its flags to an earlier one, `git push origin | grep -f patterns` is not a force-push.
 *
 * IT REPORTS WHERE, not just whether (matchCommand below). A permission card holding four hundred characters of
 * shell has to answer one question before anything else on it can be read: which part of this is the part that
 * stopped it. That answer only exists here, at the moment a pattern fires, and re-deriving it in the browser
 * would be a second classifier with all the ways to disagree with this one. So every table hands back offsets
 * and the card marks them; `classifyCommand` is the same walk with the offsets dropped.
 *
 * AND IT TAKES A FACT WHERE THE CALLER HAS ONE (CommandContext below). Every table here is a pattern over text,
 * which is exactly the right instrument for a verb — `git push --force` means what it says, and no amount of
 * looking at the repository makes it mean less. It is the WRONG instrument on its own for a class defined by a
 * FILE: `secrets.access` fires on `~/.npmrc` because that path usually holds a token, and "usually" left this
 * raising cards over registry config, over `.env` files holding a port number, over `~/.ssh/known_hosts`, and
 * over files that were not there at all. Those cards are not near misses, they are noise, and noise is what
 * teaches an owner to answer a card without reading it. A caller that can open the file (guard/credential-
 * files.ts, on the sandbox that is about to run the command) answers the question the pattern could only guess
 * at, and only ever in the direction of dropping a class it positively cleared — see credentialReads.
 */

// A half-open slice of the command text, in UTF-16 code units, the offsets a renderer slices with.
export interface CommandSpan {
    readonly start: number;
    readonly end: number;
}

// One class the command fell in, and the fragments that put it there. `spans` is never empty: a class with
// nothing to point at is a class this walk does not report.
export interface CommandMatch {
    readonly commandClass: CommandClass;
    readonly spans: readonly CommandSpan[];
}

/* WHAT THE CALLER CAN CHECK THAT THE PATTERNS CANNOT. Optional everywhere: absent ⇒ every table answers from
 * the command text alone, which is what the browser, the machine agent and every test that does not care get. */
export interface CommandContext {
    /* Does the file at this path — as the command spells it, `~/.npmrc`, `.env`, `/work/app/.env.local` — hold
     * credential material? (credential-material.ts says what that means; the caller says how to read a file.)
     *
     * THREE ANSWERS, and the third is the important one. `true` ⇒ it does. `false` ⇒ it was opened and read and
     * there is no credential in it, or there is no such file. `undefined` ⇒ COULD NOT TELL: a path built from a
     * variable, a glob, a directory, a file on another machine, an unreadable one. Only `false` drops a class;
     * a rule that fell back to "no" whenever nobody could look would be a rule that quietly stopped applying
     * exactly where checking was hardest. */
    readonly holdsSecret?: (path: string) => boolean | undefined;
}

/* The `g` twin of a table's patterns, built once. The tables are written WITHOUT `g` because a lastIndex that
 * survives a call is the classic way a shared regex starts skipping every other match, and `test` is what the
 * verdict path wants. `matchAll` demands one, so the twins live here instead of being flagged in place.
 * (`matchAll` clones the regex it is given, so these stay stateless too.) */
const globally = (patterns: readonly RegExp[]): readonly RegExp[] => patterns.map((pattern) => new RegExp(pattern.source, `${pattern.flags}g`));

// Every occurrence of every pattern, as spans over `command`. The WHOLE match, not a capture group: a pattern
// here is written to span the consequence (`git push … --force`, `curl … https://`), and cutting it back to a
// group would point at the flag while leaving the verb it belongs to unmarked.
const spansOf = (patterns: readonly RegExp[], command: string): CommandSpan[] =>
    patterns.flatMap((pattern) => [...command.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length })));

/* Sorted, with overlaps folded together. Two patterns firing on one fragment is ordinary here (a script's
 * recursive delete matches both the with-a-literal-path pattern and the any-path one), and handing a renderer
 * overlapping ranges makes it either double-paint or reinvent this. Adjacency is NOT merged: touching spans
 * from genuinely different fragments read correctly as two marks.
 *
 * EXPORTED because a caller that marks SEVERAL classes at once needs it too, and the overlap it has to fold is
 * across classes rather than within one: `rm -rf /work` is both files.destructive and system.destructive on the
 * same characters, and a card that painted both would hand its renderer two ranges over one fragment. The
 * command gate marks every matched class now (guard/command-gate.ts says why), so this is the second caller. */
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

/* THE CREDENTIAL THAT IS IN THE COMMAND, not in some file the command names. `{{secret:NAME}}` becomes the real
 * value on the way into the process (agent/agent-secrets.ts), so a command carrying one is reading a credential
 * by definition and there is nothing for a filesystem to add: this half of the class is never fact-checked.
 *
 * Without it the outside-content floor in guard/actions.ts is bypassed by writing a reference into a curl
 * instead of reading a dotenv, which is the shorter route to the same place: `curl -d @.env` is held,
 * `curl -d '{"t":"{{secret:X}}"}'` was not. The alphabet is REFERENCE's, from secrets/secret-registry.ts,
 * respelled rather than imported to keep this table free of a dependency on the stores it describes. */
const SECRET_REFERENCES = [/\{\{secret:[A-Za-z0-9_./-]+\}\}/];

/* A PATH THAT USUALLY HOLDS A CREDENTIAL — a guess about a FILE, which is why every entry here is subject to
 * CommandContext.holdsSecret and the table above is not. Each pattern spans as much of the path as it can, so
 * the card marks `.ssh/id_ed25519` rather than `.ssh`, and so the word around it (enclosingPath) resolves.
 *
 * WHAT IS DELIBERATELY NOT HERE is as much of the definition as what is: the public half of a keypair, the
 * host list beside it, and the checked-in templates that ship next to the real file in every repo. None of
 * those is credential material in any file, so no fact-check is needed to know they do not belong — and each
 * of them was, before this, an ordinary setup command earning a card that said "read credential material". */
/* The directory part in front of a filename, so a pattern spans `~/.aws/credentials` rather than the
 * `.aws/credentials` inside it: what the card marks then reads as the file, and the word handed to the
 * fact-check IS the file. Permissive about `~` and `${HOME}` on purpose — expanding those is the checker's job
 * (guard/credential-files.ts), and a path this over-reaches on resolves to nothing, which changes nothing. */
const LEADING_PATH = String.raw`[\w~$.{}/\\-]*`;

const CREDENTIAL_PATHS = [
    /* A dotenv file: `.env`, `.env.production`, `-d @.env`. NOT the checked-in templates that sit beside it in
     * every repo, and not `process.env`, the lookbehind is what excludes the latter, which is otherwise the
     * single most common string in this workspace's own commands and would hold every grep for it. */
    /(?<![\w.])\.env(?!\.(?:example|sample|template))(?:\.[\w-]+)?\b/,
    /* The ssh directory and what is under it, EXCEPT the three members that are public by design.
     * `ssh-keyscan github.com >> ~/.ssh/known_hosts` is the first thing an agent does on a fresh box, `.pub` is
     * the half of a keypair you are supposed to hand out, and `~/.ssh/config` is host aliases. The bare
     * directory still counts (`cp -r ~/.ssh /tmp` is the copy that matters, and it names no file at all), which
     * is why the lookaheads sit outside the optional path tail rather than inside it: an exclusion inside an
     * optional group is one the regex backtracks around, matching `.ssh` and reporting the class anyway. */
    /\.ssh(?!\w)(?!\/(?:known_hosts|config|authorized_keys|environment)(?!\w))(?!\/[\w.-]*\.pub(?!\w))(?:\/[\w.\-/]*)?/,
    // A private key by its conventional name. `.pub` beside it is the public half and is not this.
    /\bid_(?:rsa|dsa|ecdsa|ed25519)\b(?!\.pub\b)/,
    new RegExp(String.raw`${LEADING_PATH}\.aws/credentials\b`),
    // An npmrc, but not the checked-in template beside it — the `.env` exclusion, which this had been missing.
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
    // Where this invocation sits in the command, so a card can point at `rm -rf /work` rather than at the whole
    // line it was buried in. The invocation as matched, verb through last operand.
    readonly span: CommandSpan;
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
        parsed.push({ recursive, force, operands, span: { start: invocation.index, end: invocation.index + invocation[0].trimEnd().length } });
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

// Where a script deletes a tree, however the path reaches it. Empty ⇒ it does not.
const recursiveDeletes = (program: string): CommandSpan[] => spansOf(globally([NODE_RECURSIVE_RM, RIMRAF]), program);

/* The literal paths a script hands to a recursive delete, each with the call it sits in. Empty when every path
 * it deletes is computed, which is the honest answer rather than a guess: the class above already holds, only
 * the root question goes unasked.
 *
 * The two `_PATH` patterns are already global, so they are used directly; matchAll clones them either way. */
const nodeDeleteTargets = (program: string): { readonly target: string; readonly span: CommandSpan }[] =>
    [...program.matchAll(NODE_RECURSIVE_RM_PATH), ...program.matchAll(RIMRAF_PATH)].map((match) => ({
        target: match[2] as string,
        span: { start: match.index, end: match.index + match[0].length },
    }));

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

const recursiveForceRms = (command: string): CommandSpan[] =>
    parseRm(command)
        .filter((invocation) => invocation.recursive && invocation.force)
        .map((invocation) => invocation.span);

// A recursive delete aimed at a root, in either spelling the gate can be handed: the shell's `rm -rf /` and
// the script's `fs.rmSync("/", { recursive: true })`.
const rootDeletes = (program: string): CommandSpan[] => [
    ...parseRm(program)
        .filter((invocation) => invocation.recursive && invocation.force && invocation.operands.some(isRootTarget))
        .map((invocation) => invocation.span),
    ...nodeDeleteTargets(program)
        .filter((delete_) => isRootTarget(delete_.target))
        .map((delete_) => delete_.span),
];

// The `g` twins, built once at load rather than per call: a card is minted per held command and a classify runs
// per command the agent types, so recompiling six tables of patterns each time is work with no reader.
const GIT_DESTRUCTIVE_G = globally(GIT_DESTRUCTIVE);
const SECRET_REFERENCES_G = globally(SECRET_REFERENCES);
const CREDENTIAL_PATHS_G = globally(CREDENTIAL_PATHS);
const PACKAGE_PUBLISH_G = globally(PACKAGE_PUBLISH);
const NETWORK_OUTBOUND_G = globally(NETWORK_OUTBOUND);
const SYSTEM_DESTRUCTIVE_G = globally(SYSTEM_DESTRUCTIVE);

/* THE PATH A MATCHED FRAGMENT SITS IN, so the oracle is asked about the file the command would actually open
 * rather than about the suffix that fired: `sed 's/…/' ~/.npmrc` fires on `.npmrc` and must ask about
 * `~/.npmrc`, `curl -d @.env` fires on `.env` and must ask about `.env`.
 *
 * The shell word around the span, widened to whitespace or a separator on both sides, with the decoration a
 * shell puts in FRONT of a path removed: a redirect's arrow, curl's `@` file-body marker, a `--flag=` prefix.
 *
 * DELIBERATELY DUMB, and it can afford to be: a word this gets wrong resolves to a path the caller cannot read,
 * which is `undefined`, which leaves the class exactly where the pattern put it. The failure mode is the old
 * behaviour, not a hole. */
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

/* A WORD THAT IS A PATTERN RATHER THAN A PATH, dropped before the table's guess about a FILE is believed at all.
 *
 * The table reads shell text looking for filenames, and a search command carries something that looks exactly
 * like one and is not: `rg 'process\.env\.(INTENTIC_[A-Z]+)' --type ts .` names no file and opens nothing, and
 * it earned a card reading "this command would read credential material" over a grep of this workspace's own
 * source. The `.env` in it survives the dotenv pattern's `process.env` exclusion for one reason: the lookbehind
 * sees the REGEX'S BACKSLASH rather than the `s` of `process`, and a backslash is neither a word character nor a
 * dot. Every credential-shaped name has the same hole — `rg '\.npmrc'`, `rg '\.ssh/id_ed25519'` — so it is fixed
 * once here rather than seven times in the table.
 *
 * THE ESCAPED DOT IS THE TELL. `\.` is how a regex spells a literal dot, and a POSIX path never needs it. The
 * one thing that spells `\.` and IS a path is Windows (`type C:\Users\me\.env`), which the machine agent's shell
 * really does see — and there the other backslashes are SEPARATORS, each followed by a path segment rather than
 * by the character it escapes. That is the whole discrimination.
 *
 * A CHARACTER CLASS and a CLASS ESCAPE are the other two tells, and both are nearly free: `[…]` is legal in a
 * filename and never in one anybody writes, and `\w`, `\d`, `\b` mean nothing to a shell. The class escapes are
 * matched only where a word character does NOT follow, which is what keeps `\dev` and `\swap` (Windows
 * directories) out of them. The word edges (WORD_EDGE) already cut a word at the `(`, `|` and quotes carrying
 * the rest of a regex's syntax, so these are what is left of it by the time a word reaches here.
 *
 * Judged on the ENCLOSING WORD, the same word the fact-check would have asked the filesystem about, so a
 * pattern and a path are told apart once and both consults see the same answer. */
const CHARACTER_CLASS = /\[[^\]]*\]/;
const CLASS_ESCAPE = /\\[wdsbWDSB](?!\w)/;
const ESCAPED_DOT = /\\\./;
const PATH_SEPARATOR = /\\\w/;
const namesAPattern = (word: string): boolean =>
    CHARACTER_CLASS.test(word) || CLASS_ESCAPE.test(word) || (ESCAPED_DOT.test(word) && !PATH_SEPARATOR.test(word));

/* WHERE A COMMAND READS CREDENTIAL MATERIAL: every secret reference in it, plus every credential-shaped path the
 * context did not positively clear.
 *
 * `!== false` is the whole fact-check, and the comparison is written against `false` rather than for `true` on
 * purpose: `undefined` (nobody could look) has to behave like `true` (there is a credential in there), or the
 * class would evaporate on every caller without a filesystem. */
const credentialReads = (command: string, context: CommandContext | undefined): CommandSpan[] => [
    ...spansOf(SECRET_REFERENCES_G, command),
    ...spansOf(CREDENTIAL_PATHS_G, command).filter((span) => {
        const word = enclosingPath(command, span);
        return !namesAPattern(word) && context?.holdsSecret?.(word) !== false;
    }),
];

// WHERE each class fires, one entry per class. Empty ⇒ the command is not in it, so membership and evidence are
// the same walk and cannot disagree: there is no way to be held for a class with nothing to show for it.
const MATCHES: Readonly<Record<CommandClass, (command: string, context: CommandContext | undefined) => CommandSpan[]>> = {
    "git.destructive": (command) => spansOf(GIT_DESTRUCTIVE_G, command),
    "files.destructive": (command) => [...recursiveForceRms(command), ...recursiveDeletes(command)],
    "system.destructive": (command) => [...spansOf(SYSTEM_DESTRUCTIVE_G, command), ...rootDeletes(command)],
    "secrets.access": credentialReads,
    "package.publish": (command) => spansOf(PACKAGE_PUBLISH_G, command),
    "network.outbound": (command) => spansOf(NETWORK_OUTBOUND_G, command),
};

/* Every class the command falls in AND the fragments that put it there, in the catalog's own order so a card and
 * a log name them the same way twice. The primitive; classifyCommand is this with the offsets dropped.
 *
 * `context` is what a caller that can check a fact hands in (CommandContext); omitting it classifies from the
 * command text alone, which is every caller that has no filesystem to consult. */
export const matchCommand = (command: string, context?: CommandContext): CommandMatch[] =>
    CommandClassSchema.options.flatMap((commandClass) => {
        const spans = mergeSpans(MATCHES[commandClass](command, context));
        return spans.length === 0 ? [] : [{ commandClass, spans }];
    });

// Every class the command falls in, for the callers that only take a verdict from it (the gate's rulebook
// consult, the machine agent's scope switch).
export const classifyCommand = (command: string, context?: CommandContext): CommandClass[] =>
    matchCommand(command, context).map((match) => match.commandClass);

// What the card says the command would DO. The class name is a settings key, not a sentence to show a person.
export const COMMAND_CLASS_LABELS: Readonly<Record<CommandClass, string>> = {
    "git.destructive": "rewrite or discard git history",
    "files.destructive": "delete files recursively",
    "system.destructive": "wipe a disk, a container volume, or a whole home or root directory",
    "secrets.access": "read credential material",
    "package.publish": "publish or release a package",
    "network.outbound": "send a request out to the internet",
};

/* No verdict set lives here any more. Which classes are worth stopping for is a POLICY question now, and it is
 * answered in two places that are honest about being different: safety-policy.ts's HARD_RULE_CLASSES for the
 * one thing nothing recovers, and the owner's own written policy for everything else. The machine agent keeps
 * its own set beside its scope switches (machine/src/computer/tools/shell.ts), because "which commands need
 * the destructive switch" is a question about that capability card rather than about this catalog. */
