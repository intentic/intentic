import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { mapPool } from "@intentic/base/async";
import { errorMessage, exitCodeOf } from "@intentic/base/errors";
import { gitHeaderEnv } from "@intentic/base/git";
import { untranslatedEnv } from "@intentic/base/process";
import { type RunnerSync, type RunnerSyncWork, runnerGitUrl, runnerIncomingRef } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { AgentWorktrees } from "../conversations/worktrees/worktrees.js";
import { DEFINITION_SOURCES } from "../definition/definition.js";
import { withConversationTrailer } from "../git-identity.js";
import { commitWorktreeRemainder } from "../git/remote/root-repo.js";
import { opt } from "../opt.js";
import { repoGitDir } from "../workspace/layout/git-layout.js";
import type { RunnerIdentity } from "./runner-identity.js";

// The runner's /work mirrors the parent's: fetched before a turn, pushed to refs/runner-incoming/<id> after. The token
// rides in as GIT_CONFIG_* env (gitHeaderEnv), not argv (readable in /proc on a shared machine). Fetched refs land in
// refs/runner-parent/ first, since moving a checked-out branch straight into refs/heads/ would desync it from its
// worktree.

const execFileAsync = promisify(execFile);

// Where each fetched ref parks before the local ref moves onto it. Per repo, so no cross-repo collision.
const PARENT_MAIN_REF = "refs/runner-parent/main";
const PARENT_TURN_REF = "refs/runner-parent/turn";

// One sync at a time on this runner. Every pull moves the same parking refs and checks out the same main line in the
// shared working dir, so two conversations dispatched here together (a fan-out) would otherwise race on the repo's
// index.lock and on each other's parked refs, failing one turn before it starts.
let gitWork: Promise<unknown> = Promise.resolve();
const exclusively = <T>(work: () => Promise<T>): Promise<T> => {
    const run = gitWork.then(work, work);
    // allow(silent-catch): the failure is the caller's, through `run`; the chain only needs to know this one is over.
    gitWork = run.catch(() => undefined);
    return run;
};

// What the parent last had of a conversation's branch, per repo: moved by every pull (what came in) and every push (what
// went out). With the parent's own branch, it is how a pull tells work the parent has from work it never received.
const deliveredRef = (conversationId: string): string => `refs/runner-delivered/${conversationId}`;
// Where a build before `sync-keeps-work` set a conversation's work aside before a reset (`<prefix><ms>`). Nothing makes
// these any more; each one found is sent home to the same name in the parent's git dir and dropped here.
const rescuePrefix = (conversationId: string): string => `refs/runner-rescue/${conversationId}/`;
// Where uncommitted edits in the mirror's own working dir are kept before it moves onto the parent's main line. Git's
// own ref namespace, inside the repo's git dir on /history: nothing of it is a path under /work.
const mainRescueRef = (at: number): string => `refs/runner-rescue/main-line/${at}`;

// Who the runner's own commits (a snapshot, a replayed commit) are by, since a runner's machine may have nobody
// configured; and no hook of the repo's runs for them.
const RUNNER_COMMITTER = ["-c", "user.name=intentic runner", "-c", "user.email=runner@intentic.invalid", "-c", "core.hooksPath=/dev/null"];

// How many of a sync's repos are worked at once. They share nothing but the link: one at a time, an eleven-repo
// workspace spent ~45 s on every push and pull (ginger-v2nz, 2026-11-24), most of it on repos the turn never touched.
const REPO_CONCURRENCY = 4;

// Runs `work` over every repo of a sync, a few at once, each to its end: one repo's failure never hides another's
// delivery, and the first failure is the sync's once all are done.
const eachRepo = async (repos: RunnerSync["repos"], work: (repo: RunnerSync["repos"][number]) => Promise<void>): Promise<void> => {
    const failures: unknown[] = [];
    await mapPool(repos, REPO_CONCURRENCY, async (repo) => {
        try {
            await work(repo);
        } catch (error) {
            failures.push(error);
        }
    });
    if (failures.length > 0) {
        throw failures[0];
    }
};

// A sync line, and the work it reports when it reports some (RunnerSyncWork): the parent says the latter in the
// conversation itself.
export type SyncSay = (line: string, work?: RunnerSyncWork) => void;

export interface RunnerSyncDeps {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly worktrees: Pick<AgentWorktrees, "attached" | "worktreeDir">;
    // The conversation's title as this runner knows it, for the commit that carries a turn's leftovers home.
    readonly titleOf?: (conversationId: string) => string | undefined;
}

export const gitEnv = (identity: RunnerIdentity): NodeJS.ProcessEnv => ({
    ...process.env,
    ...gitHeaderEnv(`Authorization: Bearer ${identity.token}`),
    // A fetch that stops for a password prompt has already failed; fail it legibly instead.
    GIT_TERMINAL_PROMPT: "0",
});

// Untranslated, so a failure thrown up to the turn reads the same whatever locale the runner's machine has.
const git = async (identity: RunnerIdentity, cwd: string, args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync("git", args, { cwd, env: untranslatedEnv(gitEnv(identity)), maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
};

// Whether a failed fetch of `ref` failed because the parent has no such ref, asked of the parent's own listing:
// `ls-remote --exit-code` exits 2 when nothing matches. A malformed name matches nothing either, so it must first be one
// a ref can have. Any other answer (a listed ref, an unreachable parent) is a failure to learn, and fails the sync.
const parentLacks = async (identity: RunnerIdentity, cwd: string, url: string, ref: string): Promise<boolean> => {
    try {
        await git(identity, cwd, ["check-ref-format", ref]);
    } catch {
        // allow(silent-catch): a malformed name is not an absent branch; the fetch's own refusal is what fails the sync.
        return false;
    }
    try {
        await git(identity, cwd, ["ls-remote", "--exit-code", url, ref]);
        return false;
    } catch (error) {
        return exitCodeOf(error) === 2;
    }
};

// The working dir a composition entry means locally; "" is the workspace root itself.
const workingDirOf = (deps: RunnerSyncDeps, dir: string): string => (dir === "" ? deps.workspaceRoot : join(deps.workspaceRoot, dir));

// Puts a repo in the daemon's canonical shape: working dir in /work, real git dir on /history. Already-shaped repos are
// left alone.
const ensureRepo = async (deps: RunnerSyncDeps, identity: RunnerIdentity, repo: string, dir: string): Promise<string> => {
    const workingDir = workingDirOf(deps, dir);
    const gitDir = repoGitDir(deps.historyRoot, repo);
    await mkdir(workingDir, { recursive: true });
    try {
        await git(identity, workingDir, ["rev-parse", "--resolve-git-dir", gitDir]);
    } catch {
        // git init writes into gits/ but will not create the directory; a fresh mirror has to make it too.
        await mkdir(dirname(gitDir), { recursive: true });
        await git(identity, workingDir, ["init", "--separate-git-dir", gitDir]);
    }
    return workingDir;
};

const revParse = (identity: RunnerIdentity, cwd: string, ref: string): Promise<string> =>
    // allow(silent-catch): an absent ref is an answer here (no branch yet, nothing delivered yet), not a failure.
    git(identity, cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).catch(() => "");

const contains = async (identity: RunnerIdentity, cwd: string, tip: string, ref: string): Promise<boolean> => {
    const target = await revParse(identity, cwd, ref);
    if (target === "") {
        return false;
    }
    if (target === tip) {
        return true;
    }
    return await git(identity, cwd, ["merge-base", "--is-ancestor", tip, target]).then(
        () => true,
        () => false,
    );
};

// Whether `ancestor` is `descendant` or behind it; false for an absent commit.
const isAncestor = async (identity: RunnerIdentity, cwd: string, ancestor: string, descendant: string): Promise<boolean> =>
    ancestor !== "" &&
    descendant !== "" &&
    (await git(identity, cwd, ["merge-base", "--is-ancestor", ancestor, descendant]).then(
        () => true,
        () => false,
    ));

// Edits to tracked files, staged or not: what a reset would throw away.
const trackedChanges = async (identity: RunnerIdentity, cwd: string): Promise<boolean> =>
    (await git(identity, cwd, ["status", "--porcelain", "--untracked-files=no"])) !== "";

// How many files differ between two commits, for a line a person reads; 0 when either is absent.
const filesBetween = async (identity: RunnerIdentity, cwd: string, from: string, to: string): Promise<number> => {
    if (from === "" || to === "") {
        return 0;
    }
    const names = await git(identity, cwd, ["diff", "--name-only", "--no-renames", from, to]);
    return names.split("\n").filter((line) => line !== "").length;
};

const mergeBase = (identity: RunnerIdentity, cwd: string, a: string, b: string): Promise<string> =>
    // allow(silent-catch): unrelated histories, or an absent side, have no base, which is an answer here.
    git(identity, cwd, ["merge-base", a, b]).catch(() => "");

// Replays the commits after `base` onto the parent's branch, in the checkout; false, with the checkout as it was, when
// they do not apply cleanly.
const replayOntoParent = async (identity: RunnerIdentity, checkout: string, base: string): Promise<boolean> => {
    try {
        await git(identity, checkout, [...RUNNER_COMMITTER, "rebase", "--no-autostash", "--onto", PARENT_TURN_REF, base]);
        return true;
    } catch {
        // allow(silent-catch): a conflict is an answer here: the branch stays as it was, and the caller says so.
        // An abort with no rebase under way (one that refused to start) has nothing to undo.
        // allow(silent-catch): that refusal is the same answer.
        await git(identity, checkout, ["rebase", "--abort"]).catch(() => undefined);
        return false;
    }
};

/* WHAT A PULL DOES WITH THE CONVERSATION'S OWN CHECKOUT. Work the parent never received (edits to tracked files, commits
   it never got) is never reset away. It is committed, as a push would, and replayed onto the parent's branch, which may
   have moved while the conversation waited (a rebase onto a newer main line); where it does not replay cleanly, the
   runner's own branch stays as it was, and the next push brings it home, the parent's branch set aside. Anything else
   (nothing undelivered) takes the parent's branch as before.
   Until 2026-11-24 a pull moved such work to a rescue ref on the runner and reset. On a runner whose push did not yet
   commit a failed turn's leftovers, ginger-v2nz lost its edits to 176 files that way twice, once per resume: only its
   18 new files, untracked and so untouched by the reset, reached the parent, and the snapshot stayed on the runner. */
const settleCheckout = async (
    deps: RunnerSyncDeps,
    identity: RunnerIdentity,
    at: { readonly repo: string; readonly checkout: string; readonly conversationId: string },
    say: SyncSay,
): Promise<void> => {
    const { repo, checkout, conversationId } = at;
    const tip = await revParse(identity, checkout, "HEAD");
    const delivered = await revParse(identity, checkout, deliveredRef(conversationId));
    const dirty = tip !== "" && (await trackedChanges(identity, checkout));
    if (tip === "" || (!dirty && ((await contains(identity, checkout, tip, PARENT_TURN_REF)) || (await contains(identity, checkout, tip, deliveredRef(conversationId)))))) {
        await git(identity, checkout, ["reset", "--hard", PARENT_TURN_REF]);
        return;
    }
    if (dirty) {
        await commitLeftovers(deps, repo, conversationId, say);
    }
    const work = await revParse(identity, checkout, "HEAD");
    const parentTip = await revParse(identity, checkout, PARENT_TURN_REF);
    // The commits the parent never received start after what it last had, when that is under them, and only then are
    // they replayed. A branch the runner rewound under it says nothing of which commits the parent has (it may hold
    // them rebased), so it is counted from where the two lines meet and kept as it is.
    const fromDelivered = await isAncestor(identity, checkout, delivered, work);
    const base = fromDelivered ? delivered : await mergeBase(identity, checkout, work, parentTip);
    const files = await filesBetween(identity, checkout, base, work);
    const kept = (why: string): void =>
        say(`${repo}: kept ${files} changed files the parent never received as they are in the checkout (${why}); the next push brings them home`, {
            kind: "kept",
            repo,
            sha: work,
            files,
            ...opt("parentTip", parentTip === "" ? undefined : parentTip),
        });
    if (await trackedChanges(identity, checkout)) {
        kept("they could not be committed");
        return;
    }
    if (await isAncestor(identity, checkout, parentTip, work)) {
        say(`${repo}: carried ${files} changed files the parent never received into this turn`, { kind: "carried", repo, sha: work, files });
        return;
    }
    if (fromDelivered && (await replayOntoParent(identity, checkout, delivered))) {
        const replayed = await revParse(identity, checkout, "HEAD");
        say(`${repo}: carried ${files} changed files the parent never received into this turn, onto the parent's branch`, {
            kind: "carried",
            repo,
            sha: replayed,
            files,
        });
        return;
    }
    kept("the parent's branch moved in a way they do not replay onto");
};

// The same for a conversation's branch with no checkout here: commits the parent never received keep the branch where
// it is; otherwise it moves onto the parent's.
const settleBranch = async (identity: RunnerIdentity, at: { readonly repo: string; readonly cwd: string; readonly branch: string; readonly conversationId: string }, say: SyncSay): Promise<void> => {
    const { repo, cwd, branch, conversationId } = at;
    const tip = await revParse(identity, cwd, `refs/heads/${branch}`);
    if (tip === "" || (await contains(identity, cwd, tip, PARENT_TURN_REF)) || (await contains(identity, cwd, tip, deliveredRef(conversationId)))) {
        await git(identity, cwd, ["branch", "-f", branch, PARENT_TURN_REF]);
        return;
    }
    const parentTip = await revParse(identity, cwd, PARENT_TURN_REF);
    const files = await filesBetween(identity, cwd, await mergeBase(identity, cwd, tip, parentTip), tip);
    say(`${repo}: kept ${branch}, which holds commits the parent never received; the next push brings them home`, {
        kind: "kept",
        repo,
        sha: tip,
        files,
        ...opt("parentTip", parentTip === "" ? undefined : parentTip),
    });
};

// Sends home every snapshot an earlier build set aside for this conversation (rescuePrefix), to the same name in the
// parent's git dir, and drops it here once it is there. A failed send keeps it for the next sync.
const sendRescuesHome = async (identity: RunnerIdentity, cwd: string, url: string, repo: string, conversationId: string, say: SyncSay): Promise<void> => {
    const listed = await git(identity, cwd, ["for-each-ref", "--format=%(refname) %(objectname)", rescuePrefix(conversationId)]);
    for (const row of listed.split("\n").filter((line) => line !== "")) {
        const [ref = "", sha = ""] = row.split(" ");
        // What it was taken over: where it meets the main line the parent last sent, else its own first parent.
        const base = (await mergeBase(identity, cwd, sha, PARENT_MAIN_REF)) || (await revParse(identity, cwd, `${sha}^1`));
        const files = await filesBetween(identity, cwd, base, sha);
        try {
            await git(identity, cwd, ["push", "--no-verify", url, `+${ref}:${ref}`]);
        } catch (error) {
            say(`${repo}: work set aside here earlier could not be sent home (${errorMessage(error)}); the next sync tries again`);
            continue;
        }
        await git(identity, cwd, ["update-ref", "-d", ref]);
        const at = Number(ref.slice(rescuePrefix(conversationId).length));
        say(`${repo}: sent home ${files} changed files an earlier build of this runner set aside`, {
            kind: "rescue",
            repo,
            sha,
            files,
            ref,
            ...opt("base", base === "" ? undefined : base),
            ...opt("at", Number.isFinite(at) && at > 0 ? at : undefined),
        });
    }
};

// Before the mirror's working dir moves onto the parent's main line, keeps its uncommitted edits to tracked files under a
// rescue ref and clears them, so the checkout cannot refuse. In the shinobi-society audit (2026-11-17) every runner
// placement failed here ("Your local changes ... would be overwritten by checkout: .intentic/config/capabilities.json"):
// the runner's own daemon writes its definition sources (DEFINITION_SOURCES) into this same /work. Those are the runner's
// own live stores, which win over what the workspace delivers, so they are put back as they were once the checkout is
// done; anything else a person changed here stays on the rescue ref, named in the sync's lines.
// Only edits beyond those files are kept: the runner rewrites its own on every pull, which made a rescue ref, and a line
// saying so, on every turn (2026-11-24: one per sync of ginger-v2nz's).
const setAsideLocalEdits = async (identity: RunnerIdentity, cwd: string, said: (kept: string) => void): Promise<() => Promise<void>> => {
    const head = await revParse(identity, cwd, "HEAD");
    if (head === "" || !(await trackedChanges(identity, cwd))) {
        return async () => undefined;
    }
    const changed = (await git(identity, cwd, ["diff", "--name-status", "--no-renames", "HEAD"])).split("\n").filter((line) => line !== "");
    const snapshot = await git(identity, cwd, [...RUNNER_COMMITTER, "stash", "create", "local edits in the runner's mirror"]);
    const entries = changed.map((line) => ({ status: line[0], path: line.slice(line.indexOf("\t") + 1) }));
    if (entries.some((entry) => !DEFINITION_SOURCES.includes(entry.path))) {
        const kept = mainRescueRef(Date.now());
        await git(identity, cwd, ["update-ref", kept, snapshot]);
        said(kept);
    }
    await git(identity, cwd, ["reset", "--hard", "-q", "HEAD"]);
    const own = entries.filter((entry) => DEFINITION_SOURCES.includes(entry.path));
    return async () => {
        for (const { status, path } of own) {
            await (status === "D"
                ? rm(join(cwd, path), { force: true })
                : git(identity, cwd, ["restore", `--source=${snapshot}`, "--worktree", "--", path]));
        }
    };
};

// The same files when the mirror does not track them yet (a fresh mirror, its first pull, or one behind the commit that
// added them) while the parent's main line does: the checkout refuses with "untracked working tree files would be
// overwritten", which no rescue ref above can keep. The runner's daemon writes them before any pull, so a runner's first
// placement failed every time. They are moved aside and written back as the runner had them once the checkout is done;
// from then on they are tracked, and a later pull keeps them as the edits above.
const setAsideOwnUntracked = async (identity: RunnerIdentity, cwd: string): Promise<() => Promise<void>> => {
    const kept: { readonly path: string; readonly bytes: Buffer }[] = [];
    for (const path of DEFINITION_SOURCES) {
        const file = join(cwd, path);
        // allow(silent-catch): a file the runner has not written is nothing to keep
        const bytes = await readFile(file).catch(() => undefined);
        const tracked = await git(identity, cwd, ["ls-files", "--error-unmatch", "--", path]).then(() => true, () => false);
        const incoming = await git(identity, cwd, ["cat-file", "-e", `${PARENT_MAIN_REF}:${path}`]).then(() => true, () => false);
        if (bytes !== undefined && !tracked && incoming) {
            kept.push({ path, bytes });
            await rm(file);
        }
    }
    return async () => {
        for (const { path, bytes } of kept) {
            await mkdir(dirname(join(cwd, path)), { recursive: true });
            await writeFile(join(cwd, path), bytes);
        }
    };
};

export const syncFromParent = (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, say: SyncSay): Promise<void> =>
    exclusively(() => pullFromParent(deps, identity, input, say));

// `leftovers` false pushes the branch's tip alone: the turn is still running there, so its checkout is mid-write.
export const pushToParent = (
    deps: RunnerSyncDeps,
    identity: RunnerIdentity,
    input: RunnerSync,
    say: SyncSay,
    options: { readonly leftovers?: boolean } = {},
): Promise<void> => exclusively(() => deliverToParent(deps, identity, input, say, options.leftovers ?? true));

const pullFromParent = (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, say: SyncSay): Promise<void> =>
    eachRepo(input.repos, (repo) => pullRepo(deps, identity, input, repo, say));

const pullRepo = async (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, { repo, dir, mainBranch }: RunnerSync["repos"][number], say: SyncSay): Promise<void> => {
    const workingDir = await ensureRepo(deps, identity, repo, dir);
    const url = runnerGitUrl(identity.parentUrl, repo);
    say(`${repo}: fetching from the parent…`);
    await git(identity, workingDir, ["fetch", "--no-tags", url, `+refs/heads/${mainBranch}:${PARENT_MAIN_REF}`]);
    const putBack = await setAsideLocalEdits(identity, workingDir, (kept) => say(`${repo}: kept uncommitted edits in the runner's copy under ${kept} before syncing`));
    const putBackOwn = await setAsideOwnUntracked(identity, workingDir);
    // Moves this mirror onto the parent's own branch name, converging rather than growing a second history.
    try {
        await git(identity, workingDir, ["checkout", "-B", mainBranch, PARENT_MAIN_REF]);
    } finally {
        await putBackOwn();
        await putBack();
    }
    // Tolerates a branch the parent hasn't created yet: this repo just starts at main instead of failing. Any other
    // failure fails the sync, since the parent hard-resets onto what comes back and main lacks the earlier turns.
    const fetched = await git(identity, workingDir, ["fetch", "--no-tags", url, `+refs/heads/${input.branch}:${PARENT_TURN_REF}`])
        .then(() => true)
        .catch(async (error: unknown) => {
            if (await parentLacks(identity, workingDir, url, `refs/heads/${input.branch}`)) {
                return false;
            }
            throw error;
        });
    if (!fetched) {
        say(`${repo}: the parent has no ${input.branch} yet, starting it at ${mainBranch}`);
        await sendRescuesHome(identity, workingDir, url, repo, input.conversationId, say);
        return;
    }
    if (await deps.worktrees.attached(input.conversationId, repo)) {
        await settleCheckout(deps, identity, { repo, checkout: deps.worktrees.worktreeDir(input.conversationId, repo), conversationId: input.conversationId }, say);
    } else {
        await settleBranch(identity, { repo, cwd: workingDir, branch: input.branch, conversationId: input.conversationId }, say);
    }
    await git(identity, workingDir, ["update-ref", deliveredRef(input.conversationId), PARENT_TURN_REF]);
    await sendRescuesHome(identity, workingDir, url, repo, input.conversationId, say);
    say(`${repo}: up to date`);
};

// What a turn left uncommitted in its checkout (staged, unstaged, untracked), committed onto its branch before the push,
// as a clean turn's land would, whatever the turn's outcome. A push used to carry the branch's tip alone and only a land
// committed leftovers, which a failed or stopped turn never reaches; the next pull then moved the edits to a rescue ref
// on the runner and reset, and the resumed session went on without them.
const commitLeftovers = async (deps: RunnerSyncDeps, repo: string, conversationId: string, say: SyncSay): Promise<void> => {
    if (!(await deps.worktrees.attached(conversationId, repo))) {
        return;
    }
    const message = withConversationTrailer(`Agent: ${deps.titleOf?.(conversationId) ?? conversationId}`, conversationId);
    try {
        if (await commitWorktreeRemainder(repo, deps.worktrees.worktreeDir(conversationId, repo), message, deps.workspaceRoot)) {
            say(`${repo}: committed what the turn left uncommitted`);
        }
    } catch (error) {
        // The branch still goes: what is committed is worth delivering, and the edits stay in the checkout for the next.
        say(`${repo}: what the turn left uncommitted could not be committed (${errorMessage(error)}), so only the branch's commits go`);
    }
};

const deliverToParent = (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, say: SyncSay, leftovers: boolean): Promise<void> =>
    eachRepo(input.repos, (repo) => deliverRepo(deps, identity, input, repo, say, leftovers));

const deliverRepo = async (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, { repo, dir }: RunnerSync["repos"][number], say: SyncSay, leftovers: boolean): Promise<void> => {
    const workingDir = workingDirOf(deps, dir);
    const url = runnerGitUrl(identity.parentUrl, repo);
    if (leftovers) {
        await commitLeftovers(deps, repo, input.conversationId, say);
    }
    const tip = await revParse(identity, workingDir, `refs/heads/${input.branch}`);
    if (tip === "") {
        // A repo the turn never touched has no branch here; nothing to deliver is a normal answer.
        say(`${repo}: no ${input.branch} here, nothing to push`);
        return;
    }
    // The tip the parent already has (the branch it sent, or this tip's earlier push) costs no round trip: on an
    // eleven-repo workspace that was ten pushes of unchanged branches per delivery, twice per turn.
    if (tip !== (await revParse(identity, workingDir, deliveredRef(input.conversationId)))) {
        say(`${repo}: pushing ${tip.slice(0, 7)}…`);
        await git(identity, workingDir, ["push", "--no-verify", url, `+refs/heads/${input.branch}:${runnerIncomingRef(input.conversationId)}`]);
        await git(identity, workingDir, ["update-ref", deliveredRef(input.conversationId), tip]);
    }
    await sendRescuesHome(identity, workingDir, url, repo, input.conversationId, say);
};
