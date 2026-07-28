import { execFile, spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import type { Logger } from "pino";
import { promisify } from "node:util";

/* WAKING UP IN THE WORKTREE — an isolated turn's own view of the filesystem.
 *
 * An isolated conversation has always RUN in its worktree (cwd), but the main checkout stayed visible and
 * writable at the same absolute path everyone writes down: /work. So every absolute path an agent inherits —
 * from a memory, a CLAUDE.md, a user message quoting a file, its own earlier turn — pointed OUT of its
 * worktree and into the shared tree. Edits that took that road never pass through `land`, which is the only
 * door that records provenance, so the Changes panel shows them with no agent attribution at all
 * (agents/origins.ts) and the work never reaches agent/<id>.
 *
 * The fix is not to forbid that road. It is to make the worktree BE /work for the turn: the process runs in
 * its own mount namespace where the conversation's worktree is bind-mounted over the workspace root. The
 * agent then cannot tell the difference, and nothing has to be remembered or refused — an absolute /work path
 * is simply its own space. Writing to the main tree is still perfectly possible (see MAIN_MOUNT below); it is
 * just no longer what happens by accident.
 *
 * What the namespace must NOT hide, and so gets bound back in over the worktree's own copy:
 *   - <root>/.intentic — the workspace's daemon state: chat transcripts (~/.claude/projects symlinks into it,
 *     so a turn writing there would strand its own session), user attachments, browser output. Shared by
 *     definition; a per-worktree copy is a lost transcript.
 *   - every installed dependency tree — bound from the main checkout, replacing the absolute symlinks the
 *     no-namespace path uses (worktrees.ts). A bind keeps the same st_dev as the source, so pnpm's hardlinks
 *     work in a worktree for the first time.
 *
 * Everything else is per-namespace and dies with the turn: the mounts are private (rprivate propagation), so
 * nothing here is visible to the daemon, to another conversation, or to a main-tree turn.
 *
 * Git keeps working because no gitdir lives under /work: the root repo's .git is a pointer into
 * <historyRoot>/gits/root, and nested repos are migrated to the same shape at boot (git/git-dirs.ts). A repo
 * whose real .git sat inside /work would resolve its worktree's gitdir pointer back into the worktree itself.
 */

const execFileAsync = promisify(execFile);

// Where the REAL workspace root stays reachable inside the namespace. Not a hiding place — an isolated turn
// that genuinely means the shared tree (comparing against main, reading a sibling repo's installed deps) has
// a stable path for it, and every mount below sources from here after the shadow goes up.
export const MAIN_MOUNT = "/mnt/intentic-main";

// The workspace subdir that must stay SHARED rather than per-worktree — daemon state, not repo content.
const SHARED_STATE = ".intentic";

const MODULES = "node_modules";
// Same bound as the symlink mirroring it replaces (a monorepo's `_apps/<pkg>`, `_libs/<pkg>`).
const MAX_LINK_DEPTH = 3;

export interface IsolationPlan {
    // The conversation's root-repo worktree — what /work becomes.
    readonly worktree: string;
    // The real workspace root, bound aside at MAIN_MOUNT.
    readonly root: string;
    // Root-relative dirs owning an installed dependency tree, bound in from the main checkout ("" is the
    // root itself). Ordered shallowest-first so a parent's mount can never shadow a child's.
    readonly modules: readonly string[];
}

// POSIX single-quote escaping for the bootstrap script — every path rides as one word.
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/* WHY AN ANCHOR RATHER THAN WRAPPING THE AGENT DIRECTLY.
 *
 * `unshare` around the CLI would put the agent in a namespace, and its Bash tool straight back OUT of it: a
 * Bash command is rewritten through bin/tmux-run so the user can watch it live, and a tmux PANE is forked by
 * the tmux SERVER, which is a long-lived process in the daemon's own namespace. The pane would inherit the
 * server's mounts, not the agent's — so `Edit` would land in the worktree while `sed -i` on the same path
 * landed in the shared tree. Half-isolation is worse than none: it is the current bug with extra steps.
 *
 * So the namespace is built ONCE per turn by a tiny anchor process that does nothing but hold it open, and
 * everything that must run inside — the agent CLI, and every tmux pane the Bash hook creates — joins it by
 * pid with `nsenter`. One namespace, many entrants, and the tmux server keeps its single shared socket, so
 * the terminals panel lists and attaches to an isolated turn's sessions exactly as it always has.
 *
 * The anchor is disposable, not a lifetime: a mount namespace lives as long as ANY process sits in it, so
 * killing the anchor at turn end leaves a still-running pane (a dev server the agent started) in a perfectly
 * good namespace, and reaps the namespace only once the last of them exits.
 */

/* The shell that runs INSIDE the fresh namespace, before the agent process replaces it.
 *
 * Ordering is the whole correctness argument:
 *  1. rprivate first — without it every mount below propagates back to the daemon's namespace and the
 *     "isolated" turn silently rewrites the real /work for everyone.
 *  2. the main root is bound aside BEFORE the shadow goes up; afterwards there is no path left that names it.
 *  3. the shadow.
 *  4. the shared/dependency re-binds, each sourced from MAIN_MOUNT — the only surviving handle on the real
 *     tree — and each preceded by `mkdir -p` because a fresh checkout has no mount point for an untracked dir.
 *
 * Every step is fatal (`set -e`): a half-built namespace is worse than no namespace, because the agent would
 * be writing into a tree that looks right and is not. The caller degrades to the plain unshadowed spawn only
 * when isolation is unavailable up front (`isolationAvailable`), never after a partial build.
 *
 * The trailer is what the shell becomes once the mounts are up — `exec sleep infinity` for the anchor, after
 * announcing readiness so the caller never hands work to a half-built namespace.
 */
export const isolationScript = (plan: IsolationPlan, trailer: string = ANCHOR_TRAILER): string => {
    const lines = [
        `set -e`,
        `mount --make-rprivate /`,
        `mkdir -p ${quote(MAIN_MOUNT)}`,
        `mount --bind ${quote(plan.root)} ${quote(MAIN_MOUNT)}`,
        `mount --bind ${quote(plan.worktree)} ${quote(plan.root)}`,
    ];
    const rebind = (rel: string): void => {
        const target = join(plan.root, rel);
        lines.push(`mkdir -p ${quote(target)}`, `mount --bind ${quote(join(MAIN_MOUNT, rel))} ${quote(target)}`);
    };
    rebind(SHARED_STATE);
    for (const pkg of plan.modules) {
        rebind(pkg === "" ? MODULES : `${pkg}/${MODULES}`);
    }
    lines.push(trailer);
    return lines.join("\n");
};

// What the anchor shell becomes: one line on stdout to say the mounts are up, then a process that does
// nothing but exist so the namespace has an inhabitant. `exec` so the sleep IS the anchor pid — a shell
// waiting on a child would make the pid nsenter targets differ from the one holding the namespace.
export const ANCHOR_READY = "isolation-ready";
const ANCHOR_TRAILER = `echo ${ANCHOR_READY}\nexec sleep infinity`;

// The argv that runs `command args...` INSIDE an existing anchor's namespace. `--wd` puts the entrant at the
// workspace root as the namespace sees it — the agent's own space, and the reason a bare `cd` never leaks.
export const nsenterArgv = (anchorPid: number, cwd: string, command: string, args: readonly string[]): { command: string; args: string[] } => ({
    command: "nsenter",
    args: [`--mount=/proc/${anchorPid}/ns/mnt`, `--wd=${cwd}`, "--", command, ...args],
});

// The same thing as ONE shell word, for the callers that compose a command STRING rather than an argv — the
// Bash tool's tmux rewrite, whose pane runs a shell line. Quoted so a path with a space can't split it.
export const nsenterPrefix = (anchorPid: number, cwd: string): string =>
    `nsenter --mount=/proc/${anchorPid}/ns/mnt --wd=${quote(cwd)} -- `;

/* Can this container actually build the namespace? CAP_SYS_ADMIN is required for both `unshare --mount` and
 * `mount`, and the sandbox is launched unprivileged unless the host provider granted it
 * (_libs/providers/src/host/workspace.ts). A container that predates that flag — or a dev-host run, or CI —
 * must keep working exactly as before rather than failing every isolated turn, so this is probed once and the
 * whole feature is opt-out by absence.
 *
 * Probed, not inferred from capabilities: seccomp can block the syscall with the capability present, and the
 * only honest test is doing the thing. The probe mounts nothing — `unshare --mount true` proves the namespace,
 * and a namespace with no mount permission cannot exist (both gate on CAP_SYS_ADMIN).
 */
export const isolationAvailable = async (): Promise<boolean> => {
    try {
        await execFileAsync("unshare", ["--mount", "--propagation", "private", "true"], { timeout: 5_000 });
        return true;
    } catch {
        return false;
    }
};

// Root-relative dirs under `root` that own an installed dependency tree, shallowest-first. Stops at a nested
// repo's own boundary the same way the symlink mirroring does — a nested repo contributes its own entries
// through its own subtree, and descending past `.git` would attribute them to the parent.
export const modulesDirs = async (root: string): Promise<string[]> => {
    const found: string[] = [];
    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        if (entries.some((entry) => entry.name === MODULES)) {
            found.push(rel);
        }
        if (depth >= MAX_LINK_DEPTH) {
            return;
        }
        await Promise.all(
            entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name))
                .map((entry) => walk(join(dir, entry.name), rel === "" ? entry.name : `${rel}/${entry.name}`, depth + 1)),
        );
    };
    await walk(root, "", 0);
    // Shallowest first: a bind onto `_apps/web/node_modules` must happen while its parent dir is still the
    // worktree's own, and sorting by depth is what guarantees a parent is never mounted over afterwards.
    return found.toSorted((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
};

export interface IsolationAnchor {
    // The pid holding the namespace open — what everything else joins with nsenter.
    readonly pid: number;
    // The workspace root as the namespace sees it: where entrants start, and the agent's cwd.
    readonly cwd: string;
    // What was mounted, kept alongside the pid because every daemon-side reader of an agent's paths needs it
    // to translate them back out of the namespace (fromNamespace).
    readonly plan: IsolationPlan;
    // Drop the anchor. Anything still running inside keeps the namespace alive until it exits.
    readonly dispose: () => void;
}

/* Build the namespace and hold it open. Resolves only once the mounts are actually up — the anchor announces
 * itself on stdout — so no caller can hand work to a namespace that is still half-built and would write
 * through to the shared tree.
 *
 * Rejects rather than degrading: by the time this is called the capability was already probed, so a failure
 * here is a real fault, and an agent silently getting the main checkout is precisely what must not happen.
 */
export const startAnchor = async (plan: IsolationPlan): Promise<IsolationAnchor> => {
    const child = spawn("unshare", ["--mount", "--propagation", "private", "sh", "-c", isolationScript(plan)], {
        stdio: ["ignore", "pipe", "pipe"],
        // Detached so the anchor is its own process group: killing it must never take down a pane that the
        // agent left running inside the namespace.
        detached: true,
    });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error("turn isolation: could not spawn the namespace anchor");
    }
    const dispose = (): void => {
        child.kill("SIGKILL");
    };
    try {
        await new Promise<void>((resolve, reject) => {
            let out = "";
            let errors = "";
            child.stdout.on("data", (chunk: Buffer) => {
                out += chunk.toString();
                if (out.includes(ANCHOR_READY)) {
                    resolve();
                }
            });
            child.stderr.on("data", (chunk: Buffer) => {
                errors += chunk.toString();
            });
            // A mount that fails takes `set -e` and the whole shell with it, so an early exit IS the error
            // report — and stderr carries which mount refused.
            child.on("exit", (code: number | null) => reject(new Error(`turn isolation: namespace setup exited ${String(code)}: ${errors.trim()}`)));
            child.on("error", reject);
        });
    } catch (error) {
        dispose();
        throw error;
    }
    // The turn's own streams must not keep the daemon's event loop alive once the turn is over.
    child.unref();
    child.stdout.destroy();
    child.stderr.destroy();
    return { pid, cwd: plan.root, plan, dispose };
};

export interface TurnIsolation {
    // The plan for a conversation's worktree, or undefined when this container can't build a namespace — the
    // caller then runs the turn exactly as it did before, cwd'd into the worktree.
    readonly planFor: (worktree: string) => Promise<IsolationPlan | undefined>;
    // Whether isolation is available at all — read by worktree creation to choose mount points over symlinks.
    readonly available: () => Promise<boolean>;
}

export const createTurnIsolation = (options: { readonly root: string; readonly logger: Logger }): TurnIsolation => {
    const { root, logger } = options;
    // Probed once per daemon life: the answer is a property of how the container was launched, and re-probing
    // would spawn a process on every turn to re-learn it.
    let probe: Promise<boolean> | undefined;
    const available = (): Promise<boolean> => {
        probe ??= isolationAvailable().then((ok) => {
            if (!ok) {
                logger.warn(
                    {},
                    "turn isolation unavailable (no CAP_SYS_ADMIN) — isolated turns will see the shared /work; recreate the sandbox to enable it",
                );
            }
            return ok;
        });
        return probe;
    };
    return {
        available,
        planFor: async (worktree) => {
            if (!(await available())) {
                return undefined;
            }
            // Re-read per turn rather than cached: an install that finished since the last turn has to be
            // visible, and this is one cheap directory walk against a warm dentry cache.
            return { worktree, root, modules: await modulesDirs(root) };
        },
    };
};

/* An isolated turn's paths, translated for the DAEMON.
 *
 * The daemon lives outside the namespace, so every absolute path the agent reports (`/work/intentic/x.ts`)
 * names the main checkout from here — the wrong file with the right name. Anything the daemon resolves on the
 * agent's behalf goes through this: the post-edit diagnostics (which would type-check the main tree's copy),
 * the tool-call location chips, and the edit diffs the transcript renders.
 *
 * Only the root prefix moves, and only for an isolated turn — a path outside the workspace root (a memory
 * file under ~, /tmp scratch) is the same file in both namespaces and is returned untouched. The re-bound
 * subtrees are the exception INSIDE the root: `.intentic` and every node_modules resolve to the main tree in
 * both namespaces, so translating them would send the daemon looking in a worktree that has no such file.
 */
export const fromNamespace = (path: string, plan: IsolationPlan | undefined): string => {
    if (plan === undefined || !path.startsWith(`${plan.root}/`)) {
        return path;
    }
    const rel = path.slice(plan.root.length + 1);
    const shared = [SHARED_STATE, ...plan.modules.map((pkg) => (pkg === "" ? MODULES : `${pkg}/${MODULES}`))];
    if (shared.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
        return path;
    }
    return join(plan.worktree, rel);
};
