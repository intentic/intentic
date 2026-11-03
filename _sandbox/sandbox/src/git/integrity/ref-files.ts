import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "@intentic/base/fs";

// Loose refs a crash zeroed (refs/stash came back all NUL on 10-30): a ref file is a sha or a `ref:` line and nothing
// else, so anything else is damage. Its reflog keeps where it last pointed, which is put back when that commit is still
// here; one with nothing to go back to is set aside, since git refuses every command that walks refs past a bad one.

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SOUND_REF = /^(?:(?:[0-9a-f]{40}|[0-9a-f]{64})|ref: \S+)\n?$/;

export interface BadRef {
    // Relative to the git dir: `refs/stash`, `HEAD`, `worktrees/<id>/HEAD`.
    readonly path: string;
    // Where its reflog says it last pointed, when that line could be read.
    readonly lastLogged?: string;
}

// Every file under `refs/`, relative to the git dir.
const refFiles = async (commonDir: string, under = "refs"): Promise<string[]> => {
    // allow(silent-catch): a refs directory that cannot be listed holds no ref this can read either.
    const entries = await readdir(join(commonDir, under), { withFileTypes: true }).catch(() => []);
    const found: string[] = [];
    for (const entry of entries) {
        const path = `${under}/${entry.name}`;
        if (entry.isDirectory()) {
            // one listing per ref directory, a handful deep
            found.push(...(await refFiles(commonDir, path)));
        } else if (entry.isFile()) {
            found.push(path);
        }
    }
    return found;
};

// HEAD and each linked worktree's own HEAD.
const headFiles = async (commonDir: string): Promise<string[]> => {
    // allow(silent-catch): a repository with no linked worktrees has no worktrees directory.
    const worktrees = await readdir(join(commonDir, "worktrees")).catch((): string[] => []);
    return ["HEAD", ...worktrees.map((id) => `worktrees/${id}/HEAD`)];
};

// The reflog of a ref: `logs/<path>`, except a worktree's HEAD, whose log is in its own admin dir.
const reflogOf = (path: string): string => (path.startsWith("worktrees/") ? path.replace(/\/HEAD$/, "/logs/HEAD") : `logs/${path}`);

// The new sha of the reflog's last line: `<old> <new> <who> <when>\t<why>`.
const lastLogged = async (commonDir: string, path: string): Promise<string | undefined> => {
    // allow(silent-catch): a ref without a reflog has nothing to be put back to.
    const log = await readFile(join(commonDir, reflogOf(path)), "utf8").catch(() => "");
    const last = log.split("\n").findLast((line) => line.trim() !== "");
    const sha = last?.split(" ")[1];
    return sha !== undefined && SHA.test(sha) ? sha : undefined;
};

/** The ref files in a git dir that hold neither a sha nor a symbolic ref. */
export const badRefs = async (commonDir: string): Promise<BadRef[]> => {
    const bad: BadRef[] = [];
    for (const path of [...(await headFiles(commonDir)), ...(await refFiles(commonDir))]) {
        // one small read per ref; a lock file beside one is a writer's, not a ref
        // allow(silent-catch): a ref deleted between the listing and the read is not damage.
        const text = path.endsWith(".lock") ? undefined : await readFile(join(commonDir, path), "utf8").catch(() => undefined);
        if (text !== undefined && !SOUND_REF.test(text)) {
            const logged = await lastLogged(commonDir, path);
            bad.push(logged === undefined ? { path } : { path, lastLogged: logged });
        }
    }
    return bad;
};

/** Points a damaged ref back at a sha, written whole. */
export const restoreRef = async (commonDir: string, path: string, sha: string): Promise<void> => {
    await writeFileAtomic(join(commonDir, path), `${sha}\n`);
};
