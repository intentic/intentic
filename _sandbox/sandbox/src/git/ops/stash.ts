import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { GitChange, StashEntry } from "@intentic/sandbox-contract";
import { parseNameStatusZ, parseNumstatZ } from "../changes/changes-porcelain.js";

// A stash entry is a real commit (sha, author, subject, diff) that `refs/stash` points at, so it belongs on the history
// graph; its parents are HEAD and the index at the time, so it hangs off the graph rather than any branch's ancestry.

const RS = "\x1e";
const US = "\x1f";

// Every stash entry, newest first, via `stash list` (not `log refs/stash`): only it numbers entries as `stash@{n}`, the
// handle every other verb takes. US/RS delimited since a message is free text.
export const stashList = async (dir: string, git: GitRunner = defaultGit): Promise<StashEntry[]> => {
    const format = `${RS}%gd${US}%H${US}%h${US}%P${US}%at${US}%gs`;
    const out = await git(dir, ["stash", "list", `--pretty=format:${format}`]).catch(() => undefined);
    if (out === undefined) {
        return [];
    }
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

// Sets the tree aside; `includeUntracked` sweeps up files git has never seen. An empty worktree exits non-zero with
// nothing to stash — a no-op, reported plainly, not a failure.
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
        const { stdout } = await git(dir, args);
        return stdout.includes("No local changes") ? { ok: false, reason: "nothing to stash" } : { ok: true };
    } catch {
        return { ok: false, reason: "could not stash" };
    }
};

// `apply` keeps the entry, `pop` drops it on a clean apply — git's own distinction, kept rather than collapsed. A
// conflict leaves markers and (for pop) keeps the entry too; reported as `ok: false`, not lost work.
export const stashApply = async (
    dir: string,
    ref: string,
    pop: boolean,
    git: GitRunner = defaultGit,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
        await git(dir, ["stash", pop ? "pop" : "apply", ref]);
        return { ok: true };
    } catch {
        return { ok: false, reason: "conflict" };
    }
};

// Discards an entry; the one verb here git can't walk back (the commit becomes unreachable), so the route checkpoints
// first.
export const stashDrop = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["stash", "drop", ref]);
};
