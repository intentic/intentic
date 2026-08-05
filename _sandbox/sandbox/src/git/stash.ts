import { defaultGit, type GitRunner } from "@intentic/scaffold";
import type { GitChange, StashEntry } from "@intentic/sandbox-contract";
import { parseNameStatusZ, parseNumstatZ } from "./changes.js";

/* THE STASH — work set aside without committing it.
 *
 * A stash entry IS a commit (git builds one, off to the side, and points `refs/stash` at it), which is why this
 * belongs in the history surface rather than beside the working-tree verbs: it has a sha, an author, a subject
 * and a diff, and the graph can draw it exactly like anything else. What it does NOT have is a place in any
 * branch's ancestry — its parents are HEAD and the index at the moment it was made — so it hangs off the graph
 * rather than flowing down it.
 *
 * Nothing in this daemon created stashes before, which is the honest reason the workspace never showed them: an
 * agent or a user typing `git stash` in a terminal had their work vanish from every surface here. */

const RS = "\x1e";
const US = "\x1f";

/* Every stash entry, newest first.
 *
 * `git stash list` with a pretty format rather than `git log refs/stash` — the reflog IS the stash list, and only
 * `stash list` numbers the entries as `stash@{n}`, which is the handle every other verb takes. Fields are US
 * delimited and records RS delimited for the reason commitLog does it: a stash message is free text.
 */
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
        // `%gs` is the reflog subject: "WIP on main: 1a2b3c subject" for an unnamed stash, or "On main: my
        // message" for a named one. Both name the branch first, and what follows the colon is what the user
        // would recognise as the message.
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

/* The files one stash entry holds — the same shape, and the same status + numstat pairing, a commit's changed
 * files use, so the graph's detail renders the two identically.
 *
 * `git stash show -u` rather than a diff-tree against `<ref>^`, and that is not a stylistic choice: a stash made
 * with `--include-untracked` keeps those files in a THIRD PARENT commit of its own, outside the tracked-changes
 * tree entirely. Diffing the entry against its first parent therefore reports every untracked file as absent —
 * which is exactly the case the flag exists to cover, so the answer would be wrong for the stashes people most
 * need to look inside. `stash show` knows about all three parents; nothing else does.
 */
export const stashChanges = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<GitChange[]> => {
    const [statusOut, statsOut] = await Promise.all([
        git(dir, ["stash", "show", "--include-untracked", "--name-status", "-r", "-z", ref]),
        git(dir, ["stash", "show", "--include-untracked", "--numstat", "-r", "-z", ref]),
    ]);
    const status = parseNameStatusZ(statusOut.stdout);
    const stats = parseNumstatZ(statsOut.stdout);
    return status.map((change) => Object.assign(change, stats.get(change.path)));
};

// Set the working tree aside. `includeUntracked` also sweeps up files git has never seen — the usual reason a
// stash "did not stash everything". An empty worktree makes git exit non-zero with nothing stashed, which is a
// no-op rather than a failure, so the caller is told plainly.
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

/* Put a stash back. `apply` keeps the entry, `pop` drops it on a clean apply — which is git's own distinction and
 * worth preserving rather than picking one: pop is what people mean by "resume this", apply is what they mean by
 * "try this here too".
 *
 * A conflicting apply leaves the worktree with conflict markers AND (for pop) keeps the entry, which is git's
 * behaviour and the right one — the work is not lost. Reported as `ok: false` so the caller can say so.
 */
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

// Discard a stash entry. The one verb here git cannot walk back on its own — the entry's commit becomes
// unreachable — so the route checkpoints before it runs.
export const stashDrop = async (dir: string, ref: string, git: GitRunner = defaultGit): Promise<void> => {
    await git(dir, ["stash", "drop", ref]);
};
