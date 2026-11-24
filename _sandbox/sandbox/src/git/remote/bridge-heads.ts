import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BridgeHead } from "@intentic/sandbox-contract/schemas/bridge-heads";
import { gitsRoot } from "../../workspace/layout/git-dir-owners.js";

/* WHAT A PAIRED COMPUTER'S GIT BRIDGE FOLLOWS, read off the git dirs' files (2026-11-24). The bridge on the owner's
   computer (_devices/machine/src/sync/bridge/git-bridge.ts) used to learn each repo's branch and tip with
   `git ls-remote --symref sandbox HEAD`, a fresh SSH login per repo every five seconds, and the repo list with an
   `ls /history/gits` over another login every minute: two logins a second into a ten-repo sandbox, each running sshd,
   PAM and git-upload-pack. Now the sandbox says the same on GET /ports, which the device polls anyway, and the device
   fetches only a repo whose tip moved.

   Asked every five seconds by every paired computer, so a quiet repo costs three stats and no read: HEAD, its branch's
   loose ref and packed-refs, each by inode, size and mtime. git replaces a ref by renaming a new file over it, so a move
   always shows in the inode even within one mtime tick. Never a git spawn. */

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

// A file's identity for the cache, or "-" when it is not there (an absent loose ref is a state too).
const stampOf = async (path: string): Promise<string> => {
    // allow(silent-catch): any reason a path cannot be looked at (missing, ENOTDIR under a branch with a slash) reads as absent.
    const info = await stat(path).catch(() => undefined);
    return info === undefined ? "-" : `${info.ino}:${info.size}:${info.mtimeMs}`;
};

// allow(silent-catch): a file that cannot be read reads as absent; the caller decides what absent means.
const readText = async (path: string): Promise<string | undefined> => await readFile(path, "utf8").catch(() => undefined);

// packed-refs' `<sha> <refname>` lines, past its `#` header and the `^<sha>` peeled lines under annotated tags.
export const parsePackedRefs = (text: string): ReadonlyMap<string, string> => {
    const refs = new Map<string, string>();
    for (const line of text.split("\n")) {
        const match = /^([0-9a-f]+) (\S+)$/.exec(line.trim());
        if (match?.[1] !== undefined && match[2] !== undefined) {
            refs.set(match[2], match[1]);
        }
    }
    return refs;
};

interface Kept {
    readonly headStamp: string;
    readonly packedStamp: string;
    // The loose ref's path and stamp the answer was read with; undefined when HEAD named no branch.
    readonly loose: { readonly path: string; readonly stamp: string } | undefined;
    readonly head: BridgeHead | undefined;
}

// One git dir's head, read from scratch. Undefined for a dir with no HEAD: not a repository, so nothing to bridge.
const readHeadOf = async (repo: string, gitDir: string, packed: () => Promise<ReadonlyMap<string, string>>): Promise<Omit<Kept, "headStamp" | "packedStamp">> => {
    const text = (await readText(join(gitDir, "HEAD")))?.trim();
    if (text === undefined) {
        return { loose: undefined, head: undefined };
    }
    const named = /^ref:\s*(\S+)$/.exec(text)?.[1];
    // A detached HEAD (a bare sha) or one naming something other than a branch: nothing a bridge follows, as
    // ls-remote's answer for it was not either.
    if (named === undefined || !named.startsWith("refs/heads/")) {
        return { loose: undefined, head: { repo } };
    }
    const branch = named.slice("refs/heads/".length);
    // reftable keeps HEAD naming `refs/heads/.invalid` and its refs in a format this does not read.
    if (branch === ".invalid" || branch === "") {
        return { loose: undefined, head: { repo, probe: true } };
    }
    const path = join(gitDir, named);
    const stamp = await stampOf(path);
    const loose = stamp === "-" ? undefined : (await readText(path))?.trim();
    if (loose !== undefined) {
        // A symbolic branch ref, or one caught torn: let git answer over SSH rather than guess.
        return { loose: { path, stamp }, head: SHA.test(loose) ? { repo, branch, tip: loose } : { repo, branch, probe: true } };
    }
    const tip = (await packed()).get(named);
    // No loose ref and none packed: a branch with no commits yet.
    return { loose: { path, stamp }, head: tip !== undefined && SHA.test(tip) ? { repo, branch, tip } : { repo, branch } };
};

export interface BridgeHeads {
    // Every repository under /history/gits but the workspace's own root, sorted by name.
    readonly list: () => Promise<BridgeHead[]>;
}

export const createBridgeHeads = (historyRoot: string): BridgeHeads => {
    const root = gitsRoot(historyRoot);
    const kept = new Map<string, Kept>();

    const headOf = async (repo: string, entry: string): Promise<BridgeHead | undefined> => {
        const gitDir = join(root, entry);
        const packedPath = join(gitDir, "packed-refs");
        // Stamped before anything is read: a write landing between the stamp and the read leaves a stamp that no longer
        // matches, so the next ask reads again.
        const [headStamp, packedStamp] = await Promise.all([stampOf(join(gitDir, "HEAD")), stampOf(packedPath)]);
        const before = kept.get(entry);
        if (
            before !== undefined &&
            before.headStamp === headStamp &&
            before.packedStamp === packedStamp &&
            (before.loose === undefined || (await stampOf(before.loose.path)) === before.loose.stamp)
        ) {
            return before.head;
        }
        const packed = async (): Promise<ReadonlyMap<string, string>> => parsePackedRefs((await readText(packedPath)) ?? "");
        const read = await readHeadOf(repo, gitDir, packed);
        kept.set(entry, { headStamp, packedStamp, ...read });
        return read.head;
    };

    return {
        list: async () => {
            // allow(silent-catch): a sandbox with no gits folder yet has no repositories to advertise.
            const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
            const names = entries.filter((entry) => entry.isDirectory() && entry.name !== "root").map((entry) => entry.name);
            for (const entry of kept.keys()) {
                if (!names.includes(entry)) {
                    kept.delete(entry);
                }
            }
            const heads = await Promise.all(
                names.map(async (entry) => {
                    let repo: string;
                    try {
                        repo = decodeURIComponent(entry);
                    } catch {
                        // allow(silent-catch): a malformed URI escape is not a name the sandbox gave a git dir, so nothing to advertise.
                        return undefined;
                    }
                    return await headOf(repo, entry);
                }),
            );
            return heads.filter((head) => head !== undefined).toSorted((a, b) => a.repo.localeCompare(b.repo));
        },
    };
};
