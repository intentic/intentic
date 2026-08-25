import { type CommandClass, CommandClassSchema } from "@intentic/sandbox-contract";

/* WHICH CLASSES A SHELL COMMAND FALLS IN, the command gate's classifier, read before a Bash call runs.
 *
 * ALL of them, not the first match, because the gate takes the most restrictive verdict across them and the
 * interesting commands are exactly the ones in two classes at once: `curl -d @.env https://…` is both
 * `secrets.access` and `network.outbound`, and an owner who holds either meant to see it. Returning one class
 * would let a rule on the other decide.
 *
 * HONESTY, the same note the outbound sniffer carries and for the same reason. This is regex over shell text.
 * A creatively quoted command, a path assembled from a variable, or a script written in one call and run in the
 * next goes past it untouched. So the gate is friction and a prompt for well-behaved work, never a boundary,
 * the boundaries are structural and elsewhere: the container, the isolated worktree, the land gate, and an
 * automation's tool allowlist (the only thing that stops a turn nobody is watching from reaching Bash at all).
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
     * this class whatever else it does. Without it the outside-content floor in actions.ts is bypassed by
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
 * with it the outside-content envelope and the turn's taint bit: outsideSourceOf (outside-results.ts) is built
 * on this class, so a response judged loopback is never wrapped and never marks the turn. The trailing
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

// The verb of an `rm` invocation and the flag words that follow it. Read as FLAGS rather than matched as text,
// so every spelling of a recursive-force delete lands the same: `-rf`, `-fr`, `-r -f`, `--recursive --force`.
const RM_FLAGS = /\brm\s+((?:-{1,2}[a-zA-Z][\w-]*\s+)+)/g;

const isRecursiveForce = (command: string): boolean => {
    for (const invocation of command.matchAll(RM_FLAGS)) {
        let recursive = false;
        let force = false;
        for (const word of (invocation[1] as string).trim().split(/\s+/)) {
            // A long flag is one whole word; a short cluster is a bag of letters. `--force` must not be read as
            // the letters f-o-r-c-e, or every `rm --force` would look recursive too.
            if (word.startsWith("--")) {
                recursive ||= word === "--recursive";
                force ||= word === "--force";
                continue;
            }
            recursive ||= /[rR]/.test(word);
            force ||= word.includes("f");
        }
        if (recursive && force) {
            return true;
        }
    }
    return false;
};

const MATCHES: Readonly<Record<CommandClass, (command: string) => boolean>> = {
    "git.destructive": (command) => GIT_DESTRUCTIVE.some((pattern) => pattern.test(command)),
    "files.destructive": isRecursiveForce,
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
    "secrets.access": "read credential material",
    "package.publish": "publish or release a package",
    "network.outbound": "send a request out to the internet",
};
