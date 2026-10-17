import { exitCodeOf } from "@intentic/base/errors";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import type { GitChange } from "@intentic/sandbox-contract/schemas/git/git";
import type { StashEntry } from "@intentic/sandbox-contract/schemas/git/git-history";
import { parseNameStatusZ, parseNumstatZ } from "../changes/changes-porcelain.js";
import { gitFailureReason } from "../git.js";

// A stash entry is a real commit (sha, author, subject, diff) that `refs/stash` points at, so it belongs on the history
// graph; its parents are HEAD and the index at the time, so it hangs off the graph rather than any branch's ancestry.

const RS = "\x1e";
const US = "\x1f";

// Every stash entry, newest first, via `stash list` (not `log refs/stash`): only it numbers entries as `stash@{n}`, the
// handle every other verb takes. US/RS delimited since a message is free text.
export const stashList = async (dir: string, git: GitRunner = defaultGit): Promise<StashEntry[]> => {
    const format = `${RS}%gd${US}%H${US}%h${US}%P${US}%at${US}%gs`;
    // No stash (and an unborn HEAD) is an empty listing with exit 0; a failure is not an empty list.
    const out = await git(dir, ["stash", "list", `--pretty=format:${format}`]);
    const entries: StashEntry[] = [];
    for (const record of out.stdout.split(RS)) {
        if (record === "") {
            continue;
        }
        const [ref, sha, short, parents, at, ...rest] = record.split(US);
        if (ref === undefined || sha === undefined) {
            continue;
        }
        // `%gs`, the reflog subject: `WIP on main: <sha> subject` (unnamed) or `On main: message` (named); both name
        // the branch first.
        const raw = rest.join(US).trim();
        const match = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(raw);
        entries.push({
            ref: ref.trim(),
            sha,
            short: short ?? "",
            subject: match?.[2]?.trim() ?? raw,
            ...(match?.[1] !== undefined ? { branch: match[1].trim() } : {}),
            at: Number(at ?? "0") * 1000,
            parents: (parents ?? "").split(" ").filter((parent) => parent !== ""),
        });
    }
    return entries;
};

// Same status+numstat shape as a commit's changes. Uses `stash show -u`, not a diff against `<ref>^`: untracked files
// live in a third parent of their own, which only `stash show` knows to include.
export const stashChanges = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    const [statusOut, statsOut] = await Promise.all([
        git(dir, ["stash", "show", "--include-untracked", "--name-status", "-r", "-z", ref]),
        git(dir, ["stash", "show", "--include-untracked", "--numstat", "-r", "-z", ref]),
    ]);
    const status = parseNameStatusZ(statusOut.stdout);
    const stats = parseNumstatZ(statsOut.stdout);
    return status.map((change) => Object.assign(change, stats.get(change.path)));
};

// The commit `refs/stash` names, undefined when there is no stash: `rev-parse -q --verify` exits 1, silently, for a
// missing ref, and anything else is a failure to read it.
const stashTip = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    try {
        return (await git(dir, ["rev-parse", "-q", "--verify", "refs/stash"])).stdout.trim();
    } catch (error) {
        if (exitCodeOf(error) === 1) {
            return undefined;
        }
        throw error;
    }
};

// Sets the tree aside; `includeUntracked` sweeps up files git has never seen. With nothing to stash git exits 0 and
// writes no entry, so a `refs/stash` that did not move is the no-op, reported plainly, not a failure.
export const stashPush = async (
    dir: string,
    options: { message?: string; includeUntracked?: boolean } = {},
    git: GitRunner = defaultGit,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const args = ["stash", "push"];
    if (options.includeUntracked === true) {
        args.push("--include-untracked");
    }
    if (options.message !== undefined && options.message !== "") {
        args.push("--message", options.message);
    }
    try {
        const before = await stashTip(dir, git);
        await git(dir, args);
        return (await stashTip(dir, git)) === before ? { ok: false, reason: "nothing to stash" } : { ok: true };
    } catch (error) {
        return { ok: false, reason: gitFailureReason(error, "could not stash") };
    }
};

// The index's unmerged (stage 1-3) entries, NUL-joined: what a conflicted merge leaves behind.
const unmergedEntries = async (dir: string, git: GitRunner): Promise<string> => (await git(dir, ["ls-files", "--unmerged", "-z"])).stdout;

// `apply` keeps the entry, `pop` drops it on a clean apply — git's own distinction, kept rather than collapsed. A
// conflict leaves markers and (for pop) keeps the entry too; reported as `ok: false`, not lost work. Any other refusal
// (local changes the apply would overwrite, an unknown ref, an index already mid-merge) moved nothing, and carries
// git's own reason. A conflict is told by the unmerged entries the failed apply wrote, not by merge-ort's wording.
export const stashApply = async (
    dir: string,
    ref: string,
    pop: boolean,
    git: GitRunner = defaultGit,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
    // allow(silent-catch): an index that cannot be listed claims no conflict; a failed apply then shows git's own reason.
    const unmergedBefore = await unmergedEntries(dir, git).catch(() => undefined);
    try {
        await git(dir, ["stash", pop ? "pop" : "apply", ref]);
        return { ok: true };
    } catch (error) {
        // allow(silent-catch): as above, the apply's own failure is what is reported.
        const unmergedAfter = await unmergedEntries(dir, git).catch(() => undefined);
        const conflicted = unmergedBefore !== undefined && unmergedAfter !== undefined && unmergedAfter !== "" && unmergedAfter !== unmergedBefore;
        return conflicted ? { ok: false, reason: "conflict" } : { ok: false, reason: gitFailureReason(error, "could not apply the stash") };
    }
};

// Discards an entry; the one verb here git can't walk back (the commit becomes unreachable), so the route checkpoints
// first.
export const stashDrop = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["stash", "drop", ref]);
};
