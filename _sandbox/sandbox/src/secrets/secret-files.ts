import { closeSync, constants, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

// Where `{{secret:NAME|file}}` puts a value: a private file in the run root the command's own process reads its command
// file from (agent-terminals.ts runRootFor), written the way that command file is (agent/tools/jobs/run-files.ts), so it
// is visible and owned exactly as that command file is, inside a domain or a fenced turn as much as on the daemon's own /tmp. The command gets the path, never the
// value, so a value with lines, quotes or `$(...)` cannot change the command it is used in.
//
// A file outlives the command (a server started in the background may read it a moment later), so it is removed after
// FILE_TTL_MS instead, and each new write sweeps any its root still holds from before a restart.

export const FILE_TTL_MS = 15 * 60_000;
const PREFIX = "intentic-secret-";
const VALUE = "value";

// The characters a path may have to be spliced into a command unquoted: anything else is refused, never quoted, since
// the quoting the agent wrapped it in is not known here.
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/u;

// Written through the directory as opened, never through a link at either name: in a fenced turn the run root belongs to
// the sandbox's user, who could otherwise swap the fresh directory or plant a link where the value is about to go.
const writePrivate = (dir: string, name: string, content: string): void => {
    const at = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        const fd = openSync(`/proc/self/fd/${String(at)}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            writeSync(fd, content);
        } finally {
            closeSync(fd);
        }
    } finally {
        closeSync(at);
    }
};

const remove = (dir: string): void => {
    try {
        rmSync(dir, { recursive: true, force: true });
    } catch {
        // allow(silent-catch): a file already gone, or a root no longer mounted, has nothing left to remove.
    }
};

const sweep = (root: string, now: number): void => {
    let names: string[];
    try {
        names = readdirSync(root).filter((name) => name.startsWith(PREFIX));
    } catch {
        // allow(silent-catch): an unreadable root has nothing this module can clear; the write below says why it failed.
        return;
    }
    for (const name of names) {
        const dir = join(root, name);
        try {
            if (now - statSync(dir).mtimeMs > FILE_TTL_MS) {
                remove(dir);
            }
        } catch {
            // allow(silent-catch): one gone between the listing and the stat is the outcome the sweep wanted.
        }
    }
};

/** Writes `value` byte for byte to a fresh private file under `root`, and answers its path. */
export const writeSecretFile = (root: string, value: string, now = Date.now()): string => {
    sweep(root, now);
    const dir = mkdtempSync(join(root, PREFIX));
    const path = join(dir, VALUE);
    if (!SAFE_PATH.test(path)) {
        remove(dir);
        throw new Error(`the run directory's path (${root}) has characters a command cannot carry unquoted`);
    }
    writePrivate(dir, VALUE, value);
    setTimeout(() => remove(dir), FILE_TTL_MS).unref();
    return path;
};
