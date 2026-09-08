import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { holdsCredentialMaterial } from "@intentic/sandbox-contract";

// Checks whether a path actually holds a credential, the sandbox's half of `secrets.access`. May only subtract, and
// only on evidence: `false` means the file is empty or absent, everything else undefined, which the classifier treats
// as a hit. Nothing read here is returned, logged, or kept.

// Big enough for a dotenv, npmrc, aws ini or PEM key; past this the answer is undefined, not false.
const MAX_BYTES = 256 * 1024;

// Unresolvable: globs, substitutions, braces, a colon (remote path); a wrong guess falsely clears the class.
const UNRESOLVABLE = /[*?$`{}[\]:]/;

// The three spellings of home (`~`, `$HOME`, `${HOME}`) whose location isn't in doubt.
const expandHome = (path: string): string => {
    if (path === "~" || path.startsWith("~/")) {
        return join(homedir(), path.slice(1));
    }
    const home = /^\$(?:HOME\b|\{HOME\})/.exec(path);
    return home === null ? path : join(homedir(), path.slice(home[0].length));
};

// Resolves which file the command means, absolute, or undefined when that can't be known. A relative path resolves
// against cwd; no cwd leaves it unresolved.
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

// The whole judgement, over a file known to exist. Every uncertain answer comes back undefined, not false.
const judge = (file: string): boolean | undefined => {
    try {
        const stats = statSync(file);
        // A directory or non-file keeps the class; it has no contents to read but a copy of it still would be one.
        if (!stats.isFile() || stats.size > MAX_BYTES) {
            return undefined;
        }
        const text = readFileSync(file, "utf8");
        // A NUL byte means this isn't a text config file (a DER key, a database); not judged rather than cleared.
        return text.includes("\0") ? undefined : holdsCredentialMaterial(text);
    } catch (error) {
        // ENOENT is the one failure that's an answer: no file, so no credential; every other failure stays undefined.
        return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
    }
};

// Oracle the command gate hands the classifier (CommandContext.holdsSecret), bound to the turn's cwd.
export const createCredentialOracle =
    (cwd?: string) =>
    (path: string): boolean | undefined => {
        const file = resolveNamedFile(path, cwd);
        return file === undefined ? undefined : judge(file);
    };
