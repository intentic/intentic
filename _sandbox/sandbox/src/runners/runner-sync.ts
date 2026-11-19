import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { exitCodeOf } from "@intentic/base/errors";
import { gitHeaderEnv } from "@intentic/base/git";
import { untranslatedEnv } from "@intentic/base/process";
import { type RunnerSync, runnerGitUrl, runnerIncomingRef } from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { AgentWorktrees } from "../conversations/worktrees/worktrees.js";
import { DEFINITION_SOURCES } from "../definition/definition.js";
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
const rescueRef = (conversationId: string, at: number): string => `refs/runner-rescue/${conversationId}/${at}`;
// Where uncommitted edits in the mirror's own working dir are kept before it moves onto the parent's main line.
const mainRescueRef = (at: number): string => `refs/runner-rescue/main-line/${at}`;

export interface RunnerSyncDeps {
    readonly workspaceRoot: string;
    readonly historyRoot: string;
    readonly worktrees: Pick<AgentWorktrees, "attached" | "worktreeDir">;
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

// Before a pull moves a conversation's branch onto the parent's, keeps whatever the parent never had under a rescue ref:
// commits neither on the parent's branch nor delivered by a push, and (in a checkout) uncommitted edits. A pull used to
// hard-reset them away; it did on 2026-11-04 to a turn the parent had lost track of, which was still working there.
const keepUndelivered = async (
    identity: RunnerIdentity,
    at: { readonly cwd: string; readonly ref: string; readonly checkout: boolean },
    conversationId: string,
    said: (kept: string) => void,
): Promise<void> => {
    const tip = await revParse(identity, at.cwd, at.ref);
    if (tip === "") {
        return;
    }
    const dirty = at.checkout && (await git(identity, at.cwd, ["status", "--porcelain", "--untracked-files=no"])) !== "";
    if (!dirty && ((await contains(identity, at.cwd, tip, PARENT_TURN_REF)) || (await contains(identity, at.cwd, tip, deliveredRef(conversationId))))) {
        return;
    }
    // Named here, since a snapshot commit needs an author and a runner's machine may have none configured.
    const snapshot = dirty
        ? await git(identity, at.cwd, ["-c", "user.name=intentic runner", "-c", "user.email=runner@intentic.invalid", "stash", "create", `undelivered work of ${conversationId}`])
        : "";
    const kept = rescueRef(conversationId, Date.now());
    await git(identity, at.cwd, ["update-ref", kept, snapshot === "" ? tip : snapshot]);
    said(kept);
};

// Before the mirror's working dir moves onto the parent's main line, keeps its uncommitted edits to tracked files under a
// rescue ref and clears them, so the checkout cannot refuse. In the shinobi-society audit (2026-11-17) every runner
// placement failed here ("Your local changes ... would be overwritten by checkout: .intentic/config/capabilities.json"):
// the runner's own daemon writes its definition sources (DEFINITION_SOURCES) into this same /work. Those are the runner's
// own live stores, which win over what the workspace delivers, so they are put back as they were once the checkout is
// done; anything else a person changed here stays on the rescue ref, named in the sync's lines.
const setAsideLocalEdits = async (identity: RunnerIdentity, cwd: string, said: (kept: string) => void): Promise<() => Promise<void>> => {
    const head = await revParse(identity, cwd, "HEAD");
    if (head === "" || (await git(identity, cwd, ["status", "--porcelain", "--untracked-files=no"])) === "") {
        return async () => undefined;
    }
    const changed = (await git(identity, cwd, ["diff", "--name-status", "--no-renames", "HEAD"])).split("\n").filter((line) => line !== "");
    const snapshot = await git(identity, cwd, ["-c", "user.name=intentic runner", "-c", "user.email=runner@intentic.invalid", "stash", "create", "local edits in the runner's mirror"]);
    const kept = mainRescueRef(Date.now());
    await git(identity, cwd, ["update-ref", kept, snapshot]);
    said(kept);
    await git(identity, cwd, ["reset", "--hard", "-q", "HEAD"]);
    const own = changed.map((line) => ({ status: line[0], path: line.slice(line.indexOf("\t") + 1) })).filter((entry) => DEFINITION_SOURCES.includes(entry.path));
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

export const syncFromParent = (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, onLine: (line: string) => void): Promise<void> =>
    exclusively(() => pullFromParent(deps, identity, input, onLine));

export const pushToParent = (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, onLine: (line: string) => void): Promise<void> =>
    exclusively(() => deliverToParent(deps, identity, input, onLine));

const pullFromParent = async (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, onLine: (line: string) => void): Promise<void> => {
    for (const { repo, dir, mainBranch } of input.repos) {
        const workingDir = await ensureRepo(deps, identity, repo, dir);
        const url = runnerGitUrl(identity.parentUrl, repo);
        onLine(`${repo}: fetching from the parent…`);
        await git(identity, workingDir, ["fetch", "--no-tags", url, `+refs/heads/${mainBranch}:${PARENT_MAIN_REF}`]);
        const putBack = await setAsideLocalEdits(identity, workingDir, (kept) => onLine(`${repo}: kept uncommitted edits in the runner's copy under ${kept} before syncing`));
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
            onLine(`${repo}: the parent has no ${input.branch} yet, starting it at ${mainBranch}`);
            continue;
        }
        if (await deps.worktrees.attached(input.conversationId, repo)) {
            const checkout = deps.worktrees.worktreeDir(input.conversationId, repo);
            await keepUndelivered(identity, { cwd: checkout, ref: "HEAD", checkout: true }, input.conversationId, (kept) =>
                onLine(`${repo}: kept work the parent never received under ${kept} before syncing`),
            );
            await git(identity, checkout, ["reset", "--hard", PARENT_TURN_REF]);
        } else {
            await keepUndelivered(identity, { cwd: workingDir, ref: `refs/heads/${input.branch}`, checkout: false }, input.conversationId, (kept) =>
                onLine(`${repo}: kept work the parent never received under ${kept} before syncing`),
            );
            await git(identity, workingDir, ["branch", "-f", input.branch, PARENT_TURN_REF]);
        }
        await git(identity, workingDir, ["update-ref", deliveredRef(input.conversationId), PARENT_TURN_REF]);
        onLine(`${repo}: up to date`);
    }
};

const deliverToParent = async (deps: RunnerSyncDeps, identity: RunnerIdentity, input: RunnerSync, onLine: (line: string) => void): Promise<void> => {
    for (const { repo, dir } of input.repos) {
        const workingDir = workingDirOf(deps, dir);
        const url = runnerGitUrl(identity.parentUrl, repo);
        const tip = await git(identity, workingDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${input.branch}`]).catch(() => "");
        if (tip === "") {
            // A repo the turn never touched has no branch here; nothing to deliver is a normal answer.
            onLine(`${repo}: no ${input.branch} here, nothing to push`);
            continue;
        }
        onLine(`${repo}: pushing ${tip.slice(0, 7)}…`);
        await git(identity, workingDir, ["push", "--no-verify", url, `+refs/heads/${input.branch}:${runnerIncomingRef(input.conversationId)}`]);
        await git(identity, workingDir, ["update-ref", deliveredRef(input.conversationId), tip]);
    }
};
