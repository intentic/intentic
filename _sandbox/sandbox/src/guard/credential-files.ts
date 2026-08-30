import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { holdsCredentialMaterial } from "@intentic/sandbox-contract";

/* IS THERE ACTUALLY A CREDENTIAL IN THAT FILE — the sandbox's half of `secrets.access`, and the reason the class
 * now means what its card says.
 *
 * The classifier (sandbox-contract's command-classes.ts) can only read the command, so `~/.npmrc` gets it the
 * class on the strength of what that filename usually holds. Here, on the machine that is about to run the
 * command, the file is right there. Most of them turn out to hold nothing: an npmrc with a registry line and no
 * token, a `.env` of ports and feature flags, a path that does not exist because the agent was probing for it.
 * Each of those used to be a permission card reading "this command would read credential material", and cards
 * that are wrong are worse than no cards at all — they are what turns answering into clicking.
 *
 * IT MAY ONLY EVER SUBTRACT, and only on evidence. `false` is "I opened it and there is nothing in there", or
 * "there is no such file". Everything else — a path with a glob or a variable in it, a directory, an unreadable
 * file, one too big to be one of these, one that is not text — is `undefined`, which the classifier treats
 * exactly as it treats a yes. So the worst this can do when it is confused is leave the old behaviour standing.
 *
 * READING A SECRET TO DECIDE WHETHER TO ASK ABOUT READING A SECRET is worth saying out loud: this is the same
 * process that is a hook-return away from running the command that reads it, so the file is not crossing any
 * boundary it was not already about to cross. Nothing read here is returned, logged, or kept — the whole output
 * of this module is one boolean.
 */

/* Big enough for anything the path table names — a dotenv, an npmrc, an aws credentials ini, a PEM key — and
 * small enough that pointing the class at a multi-gigabyte file cannot make the gate read it. Past this the
 * answer is "cannot tell", which keeps the class. */
const MAX_BYTES = 256 * 1024;

/* A PATH THIS FILESYSTEM CANNOT SETTLE: a glob, a substitution, a subshell, a brace expansion — and anything
 * carrying a colon, which on a POSIX path means the file is somewhere else (`host:~/.ssh/id_rsa`,
 * `user@host:/etc/x`). Resolving one of these would be guessing which file the command means, and a wrong guess
 * in the "no credential here" direction is the single mistake this module must not make: a remote path that
 * happens not to exist locally would read as an empty file and clear a class it should have kept. `~` and
 * `$HOME` are expanded before this runs, because those two are not guesses.
 *
 * A COMMAND THAT READS A FILE SOMEWHERE ELSE BY OTHER MEANS still gets past this — `ssh host 'cat ~/.npmrc'`
 * names a path that resolves here and is read there. That is the same class of gap the classifier already
 * states plainly about itself (command-classes.ts's honesty note): this is friction for well-behaved work, and
 * the boundaries are structural and elsewhere. */
const UNRESOLVABLE = /[*?$`{}[\]:]/;

// `~`, `~/x`, `$HOME/x`, `${HOME}/x` — the three spellings of the one directory whose location is not in doubt.
const expandHome = (path: string): string => {
    if (path === "~" || path.startsWith("~/")) {
        return join(homedir(), path.slice(1));
    }
    const home = /^\$(?:HOME\b|\{HOME\})/.exec(path);
    return home === null ? path : join(homedir(), path.slice(home[0].length));
};

/* WHICH FILE THE COMMAND MEANS, absolute, or undefined where that cannot be known. A relative path resolves
 * against the turn's working directory, so `cat .env` asks about the tree the agent is actually standing in; no
 * cwd ⇒ it stays unresolved, which is the honest answer for a caller that does not know where this will run. */
const resolveNamedFile = (path: string, cwd: string | undefined): string | undefined => {
    const expanded = expandHome(path.trim());
    if (expanded === "" || UNRESOLVABLE.test(expanded)) {
        return undefined;
    }
    if (isAbsolute(expanded)) {
        return expanded;
    }
    return cwd === undefined ? undefined : resolve(cwd, expanded);
};

// The whole judgement, over one file that is known to exist somewhere. See the header for why every uncertain
// answer is `undefined` rather than `false`.
const judge = (file: string): boolean | undefined => {
    try {
        const stats = statSync(file);
        /* A directory names no contents this can read, so it keeps the class: `cp -r ~/.ssh /tmp` is a
         * credential read whatever is in there, and a socket or a device is not a file to judge. */
        if (!stats.isFile() || stats.size > MAX_BYTES) {
            return undefined;
        }
        const text = readFileSync(file, "utf8");
        // A NUL byte means this is not one of the text config files the class is about (a DER key, a database,
        // something the agent named by coincidence). Not judged rather than cleared.
        return text.includes("\0") ? undefined : holdsCredentialMaterial(text);
    } catch (error) {
        /* ENOENT is the one failure that is an ANSWER: there is no file, so nothing reads a credential out of
         * it, and `cat .env 2>/dev/null` on a repo that has none stops earning a card. Every other failure — a
         * permission error, a symlink loop, a device — is a file this cannot judge. */
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
    }
};

// The oracle the command gate hands to the classifier (sandbox-contract's CommandContext.holdsSecret), bound to
// the turn's working directory.
export const createCredentialOracle =
    (cwd?: string) =>
    (path: string): boolean | undefined => {
        const file = resolveNamedFile(path, cwd);
        return file === undefined ? undefined : judge(file);
    };
