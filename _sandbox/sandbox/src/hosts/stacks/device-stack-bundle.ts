import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { stderrOf } from "@intentic/base/errors";
import { sizeLabel } from "@intentic/base/format";
import { defaultGit } from "@intentic/base/git";
import { ORPCError } from "@orpc/server";
import { hasGitEntry, isValidRepoId, repoDirOf, ROOT_REPO } from "../../workspace/layout/repo-discovery.js";

// A WORKSPACE REPOSITORY'S COMMITTED TREE, PACKED FOR A STACK'S DEPLOY (device-stacks.ts). Only a commit is deployed,
// never the uncommitted edits around it, so what runs on the computer is something anyone can name and check out again.
// The tree is `git archive`'s: `export-ignore` paths are left out and a submodule's files are not in it. Every git here
// is run without a shell, and the only caller words that reach one are the repository id (held to the workspace's own
// repo-id rule before it becomes a path) and the compose file (held by the contract to plain path characters, and
// passed after `<commit>:`, so it can never read as an option).

// The files compose itself looks for when told none, in its own order.
export const COMPOSE_FILE_DEFAULTS: readonly string[] = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

// The most a packed tree may weigh. A compose project's source is code and configuration, megabytes; one past this
// holds datasets, media or build output that belong in a volume or a registry, and every byte of it crosses the device
// link in 2 MiB calls (256 at this size) and is unpacked and copied again on the computer. The link's own ceiling,
// ARTIFACT_MAX_BYTES (4 GiB), is sized for a disk image, not a repository.
const STACK_BUNDLE_MAX_BYTES = 512 * 1024 * 1024;

// What a deploy carries: the commit, and the compose file inside it the computer is told to run.
export interface CommittedStack {
    readonly commit: string;
    readonly composeFile: string;
}

// The packed tree on this sandbox's disk, for as long as the callback that sends it runs.
export interface PackedTree {
    readonly file: string;
    readonly size: number;
    readonly sha256: string;
}

const refused = (message: string): ORPCError<"BAD_REQUEST", unknown> => new ORPCError("BAD_REQUEST", { message });

// The repository's folder, resolved inside the workspace. The id is held to the same rule every `repo` route uses, so
// joining it under the root never climbs out; the real path is checked too, since a folder that is a symlink may lead
// anywhere. It must be a repository's own top (its `.git` is there): from a folder inside one, `git archive` would pack
// only that folder, and what was deployed would not be the repository named.
export const repoFolder = async (root: string, repo: string): Promise<string> => {
    if (repo !== ROOT_REPO && !isValidRepoId(repo)) {
        throw refused(`"${repo}" is not a repository in this workspace: name it by its folder under the workspace, like my-app or apps/web`);
    }
    const [real, realRoot] = await Promise.all([
        // allow(silent-catch): a folder that cannot be resolved is refused by name just below, whatever kept it from resolving
        realpath(repoDirOf(root, repo)).catch(() => undefined),
        realpath(root),
    ]);
    if (real === undefined) {
        throw refused(`there is no folder "${repo}" in this workspace`);
    }
    if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) {
        throw refused(`"${repo}" leads outside this workspace`);
    }
    if (!(await hasGitEntry(real))) {
        throw refused(`"${repo}" is not a git repository: a deploy carries a commit, so the folder must be a repository's own top`);
    }
    return real;
};

// HEAD's full sha, and the compose file the computer runs: the one named, which must be a file in that commit, or the
// first of compose's own defaults at the commit's root. Read off the commit rather than HEAD from here on, so a land
// moving HEAD meanwhile cannot make the tree that goes differ from the commit reported.
export const committedStack = async (dir: string, repo: string, composeFile: string | undefined): Promise<CommittedStack> => {
    const commit = await defaultGit(dir, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).then(
        ({ stdout }) => stdout.trim(),
        (error: Error) => {
            // `--quiet` keeps a missing HEAD silent, so anything git did say is another failure, passed on in its words.
            const said = stderrOf(error)?.trim() ?? "";
            throw refused(said === "" ? `"${repo}" has no commits yet: commit what should run, then deploy` : `could not read "${repo}"'s last commit: ${said}`);
        },
    );
    return { commit, composeFile: await composeFileIn(dir, repo, commit, composeFile, `"${repo}"'s last commit (${commit.slice(0, 12)})`) };
};

// (2026-11-25) The same for an exact commit, which a managed deploy names (managed-deploy.ts): a CI run's, a rollback's, the one a
// promotion copies. `commit` is a full sha already resolved (exactCommit below), so the words name it rather than HEAD.
export const stackAtCommit = async (dir: string, repo: string, commit: string, composeFile: string | undefined): Promise<CommittedStack> => ({
    commit,
    composeFile: await composeFileIn(dir, repo, commit, composeFile, `"${repo}" at ${commit.slice(0, 12)}`),
});

// The compose file inside `commit`: the one named, which must be a file there, or the first of compose's own defaults at
// its root. `which` names the commit in a refusal.
const composeFileIn = async (dir: string, repo: string, commit: string, composeFile: string | undefined, which: string): Promise<string> => {
    if (composeFile !== undefined) {
        // `-t` rather than `-e`: a folder of that name is in the commit too, and compose cannot run a folder.
        const kind = await defaultGit(dir, ["cat-file", "-t", `${commit}:${composeFile}`]).then(
            ({ stdout }) => stdout.trim(),
            // allow(silent-catch): git's only answer for a path missing from a commit is a failure, refused by name just below
            () => undefined,
        );
        if (kind !== "blob") {
            throw refused(`"${composeFile}" is not a file in ${which}: commit it, or name another compose file`);
        }
        return composeFile;
    }
    const { stdout } = await defaultGit(dir, ["ls-tree", "-z", "--name-only", commit]);
    const top = new Set(stdout.split("\0"));
    const found = COMPOSE_FILE_DEFAULTS.find((name) => top.has(name));
    if (found === undefined) {
        throw refused(`${which} has none of ${COMPOSE_FILE_DEFAULTS.join(", ")} at its root: commit one, or name the compose file to run`);
    }
    return found;
};

// The full sha of `wanted` (a full or abbreviated commit), or undefined when the repository does not hold it.
const resolvedCommit = async (dir: string, wanted: string): Promise<string | undefined> =>
    defaultGit(dir, ["rev-parse", "--verify", "--quiet", `${wanted}^{commit}`]).then(
        ({ stdout }) => stdout.trim() || undefined,
        // allow(silent-catch): `--quiet` makes a commit the repository lacks a bare failure, which is the answer asked for
        () => undefined,
    );

// (2026-11-25) The full sha of a commit a deploy names. A CI run's commit may not be here yet (the workspace pulls on
// its own clock), so one the repository lacks is fetched once from its remote and looked up again. `fetch` is the
// caller's way to the remote (managed-deploy.ts hands in the daemon's own git env); it answers why it failed, or nothing.
export const exactCommit = async (dir: string, repo: string, wanted: string, fetch: () => Promise<string | undefined>): Promise<string> => {
    if (!/^[0-9a-f]{7,64}$/.test(wanted)) {
        throw refused(`"${wanted}" is not a commit: name one by its sha, full or abbreviated`);
    }
    const local = await resolvedCommit(dir, wanted);
    if (local !== undefined) {
        return local;
    }
    const failed = await fetch();
    const fetched = await resolvedCommit(dir, wanted);
    if (fetched !== undefined) {
        return fetched;
    }
    throw refused(
        failed === undefined
            ? `"${repo}" has no commit ${wanted}, here or on its remote: push it, or name a commit that exists`
            : `"${repo}" has no commit ${wanted} here, and fetching its remote failed: ${failed}`,
    );
};

const sha256Of = async (file: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const piece of createReadStream(file)) {
        hash.update(piece);
    }
    return hash.digest("hex");
};

// Packs `commit`'s tree as a tar into a folder of its own and hands it to `send`, removing it whatever `send` does. Packed
// to disk rather than into memory: the daemon must not hold half a gigabyte for one request, and the send reads it back a
// chunk at a time. A tree past the bound is packed once and then refused, which costs the disk no more than the
// repository already takes.
export const withPackedTree = async <T>(dir: string, repo: string, commit: string, send: (packed: PackedTree) => Promise<T>): Promise<T> => {
    const folder = await mkdtemp(join(tmpdir(), "intentic-stack-"));
    try {
        const file = join(folder, "tree.tar");
        await defaultGit(dir, ["archive", "--format=tar", "-o", file, commit]);
        const { size } = await stat(file);
        if (size > STACK_BUNDLE_MAX_BYTES) {
            throw refused(
                `"${repo}" at ${commit.slice(0, 12)} packs to ${sizeLabel(size)}, past the ${sizeLabel(STACK_BUNDLE_MAX_BYTES)} a deploy carries: keep data, media and build output out of the repository (or mark them export-ignore in .gitattributes)`,
            );
        }
        return await send({ file, size, sha256: await sha256Of(file) });
    } finally {
        await rm(folder, { recursive: true, force: true });
    }
};
