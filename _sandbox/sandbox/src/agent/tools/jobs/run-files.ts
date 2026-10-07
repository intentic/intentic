import { closeSync, constants, fstatSync, openSync, readSync, renameSync, writeSync } from "node:fs";

// The daemon's own reads and writes in a run's capture dir. For a fenced turn that dir is in the turn's own temp dir
// (conversations/worktrees/turn-sandbox.ts), and the sandbox's user owns whatever root owns there: any name in it may be
// a link planted to turn the daemon's write into a write over a file root keeps (a JSON line with the agent's own
// command in it, written over a shell's rc file, is a command root runs), or its read into a read of a file the fence
// hides, handed back to the agent as its job's output. So every such file is reached through the directory as opened,
// which cannot itself be a link, and never by following a link at its own name. Nothing here throws on a planted link
// any differently from a missing file: both are a dir the run no longer answers for.

// The directory as opened: a link standing in for it is refused, and once open, renaming or replacing it changes nothing
// for the paths below, which walk the open descriptor rather than the name.
const withDir = <T>(dir: string, use: (at: (name: string) => string) => T): T => {
    const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        return use((name) => `/proc/self/fd/${String(fd)}/${name}`);
    } finally {
        closeSync(fd);
    }
};

const writeWith = (dir: string, name: string, content: string, flags: number): void =>
    withDir(dir, (at) => {
        const fd = openSync(at(name), constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | flags, 0o600);
        try {
            writeSync(fd, content);
        } finally {
            closeSync(fd);
        }
    });

/** Writes `name` in `dir`, replacing what it held; never through a link. */
export const writeRunFile = (dir: string, name: string, content: string): void => writeWith(dir, name, content, constants.O_TRUNC);

/** Appends to `name` in `dir`, creating it; never through a link. */
export const appendRunFile = (dir: string, name: string, content: string): void => writeWith(dir, name, content, constants.O_APPEND);

/** Renames within `dir`; a rename replaces a link at the target rather than following it. */
export const renameRunFile = (dir: string, from: string, to: string): void => withDir(dir, (at) => renameSync(at(from), at(to)));

/** `name` in `dir` and when it last changed, or its last `bytes` only; never through a link. */
export const readRunFile = (dir: string, name: string, bytes = Number.POSITIVE_INFINITY): { readonly text: string; readonly mtimeMs: number } =>
    withDir(dir, (at) => {
        const fd = openSync(at(name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const { size, mtimeMs } = fstatSync(fd);
            const length = Math.min(size, bytes);
            const buffer = Buffer.alloc(length);
            const read = readSync(fd, buffer, 0, length, size - length);
            return { text: buffer.subarray(0, read).toString("utf8"), mtimeMs };
        } finally {
            closeSync(fd);
        }
    });
