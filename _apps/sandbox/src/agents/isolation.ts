import { execFile, spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
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
    // Root-relative dirs owning an installed dependency tree, overlaid from the main checkout ("" is the
    // root itself). Ordered shallowest-first so a parent's mount can never shadow a child's.
    readonly modules: readonly string[];
    // Where this conversation's private overlay layers live — one upper/work pair per entry in `modules`.
    // Outside the worktree on purpose: inside it, every write an install makes would show up as untracked
    // content in the agent's own `git status` and ride its next commit.
    readonly overlays: string;
}

// A conversation's overlay scratch, and the root they all sit under. Derived here for both the daemon (which
// creates and later reclaims them) and the plan, so there is one path and not two conventions that can drift.
export const overlaysRoot = (historyRoot: string): string => join(historyRoot, "overlays");
export const overlaysDir = (historyRoot: string, id: string): string => join(overlaysRoot(historyRoot), id);

/* WHY A DEPENDENCY TREE IS AN OVERLAY AND NOT A BIND.
 *
 * node_modules has to READ as the main checkout's — an isolated turn cannot afford its own install, and the
 * bind that used to provide that also kept the same st_dev, which is what let pnpm hardlink into it.
 *
 * That last part is exactly the hole. pnpm's `injectWorkspacePackages` HARDLINKS each workspace package's
 * source files into `node_modules/.pnpm/<pkg>@file+…/`, so `node_modules/…/ext-preview/src/x.ts` and the
 * tracked `_extensions/preview/src/x.ts` in the MAIN checkout are one inode with two names. A hardlink has no
 * side: anything writing through the node_modules name — an install, a build dropping a tsbuildinfo, a stray
 * `cp` — rewrote the main checkout's tracked source, around the worktree, the agent branch and `land`. The
 * same window let a half-finished install delete a shared package out from under every other conversation.
 *
 * An overlay keeps the read and drops the write-through: the main tree is the lowerdir, so reads cost nothing
 * and see exactly what an install produced, while the first write to any path COPIES IT UP into this turn's
 * own upper layer and every later write lands there. The main checkout's inode is never opened for writing,
 * so there is nothing for a hardlink to carry back. The layers die with the conversation.
 *
 * The trade is deliberate: an upper layer is a different filesystem from the workspace, so a `pnpm install`
 * INSIDE a turn copies where it used to hardlink. Slower, and only for the turns that install.
 */
// The "device" an overlay mount reports. Cosmetic, but it is what `mount` and `df` show, so name it after
// what it is rather than leaving another anonymous `overlay` row in the sandbox's mount table.
const OVERLAY_FS_NAME = "intentic-modules";

/* Overlay options are ONE comma-separated argv word, and the kernel splits it on `,` and `:` with no
 * escaping worth relying on. Every path here is composed from the workspace root, a repo-relative directory
 * and the history root, so a comma or colon in any of them would produce a mount that fails loudly at build
 * time (`set -e`) rather than one that silently mounts the wrong thing — which is why this refuses instead. */
const overlayOptions = (lower: string, upper: string, work: string): string => {
    for (const path of [lower, upper, work]) {
        if (path.includes(",") || path.includes(":")) {
            throw new Error(`turn isolation: overlay path cannot contain "," or ":" — ${path}`);
        }
    }
    return `lowerdir=${lower},upperdir=${upper},workdir=${work}`;
};

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
 *  4. the shared state and the dependency trees, each sourced from MAIN_MOUNT — the only surviving handle on
 *     the real tree — and each preceded by `mkdir -p` because a fresh checkout has no mount point for an
 *     untracked dir. `.intentic` is a BIND, because a transcript written there has to reach the daemon; a
 *     dependency tree is an OVERLAY, because nothing written there should reach anyone (see overlayOptions).
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
    const shared = join(plan.root, SHARED_STATE);
    lines.push(`mkdir -p ${quote(shared)}`, `mount --bind ${quote(join(MAIN_MOUNT, SHARED_STATE))} ${quote(shared)}`);
    for (const pkg of plan.modules) {
        const rel = pkg === "" ? MODULES : `${pkg}/${MODULES}`;
        const target = join(plan.root, rel);
        // One layer dir per mount: upperdir and workdir must be siblings on one filesystem, and workdir must
        // not sit inside upperdir. The package's path is encoded so nested dirs can't collide or nest.
        const layer = join(plan.overlays, encodeURIComponent(rel));
        const upper = join(layer, "upper");
        const work = join(layer, "work");
        lines.push(
            `mkdir -p ${quote(target)} ${quote(upper)} ${quote(work)}`,
            `mount -t overlay ${OVERLAY_FS_NAME} -o ${quote(overlayOptions(join(MAIN_MOUNT, rel), upper, work))} ${quote(target)}`,
        );
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
export const nsenterPrefix = (anchorPid: number, cwd: string): string => `nsenter --mount=/proc/${anchorPid}/ns/mnt --wd=${quote(cwd)} -- `;

/* Can this container actually build the namespace? CAP_SYS_ADMIN is required for both `unshare --mount` and
 * `mount`, and the sandbox is launched unprivileged unless the host provider granted it
 * (_libs/providers/src/host/workspace.ts). A container that predates that flag — or a dev-host run, or CI —
 * must keep working exactly as before rather than failing every isolated turn, so this is probed once and the
 * whole feature is opt-out by absence.
 *
 * Probed, not inferred from capabilities: seccomp can block the syscall with the capability present, and the
 * only honest test is doing the thing. The probe DOES the overlay too, rather than proving the namespace
 * alone: overlayfs is a separate kernel gate (a filesystem that may simply not be built in, and one whose
 * unprivileged use is newer than the capability), and a container that can unshare but not overlay would
 * otherwise pass here and then fail `set -e` inside every anchor.
 *
 * ON THE HISTORY VOLUME, not in /tmp, and that is not a detail: overlayfs REFUSES an upperdir that is itself
 * on an overlay, and a container's own root filesystem usually IS one (docker's storage driver) — so a probe
 * in /tmp fails on exactly the healthy container this feature is for, and would switch isolation off for
 * everyone. It has to run on the filesystem the real upper layers will use, which is the one under
 * historyRoot. The probe dir is made and removed from OUT here, because the mount inside the namespace holds
 * it busy until that namespace dies.
 */
const probeScript = (dir: string): string =>
    [
        `set -e`,
        `mount -t overlay ${OVERLAY_FS_NAME} -o ${quote(overlayOptions(join(dir, "lower"), join(dir, "upper"), join(dir, "work")))} ${quote(join(dir, "merged"))}`,
    ].join("\n");

export const isolationAvailable = async (historyRoot: string): Promise<boolean> => {
    const dir = join(historyRoot, ".isolation-probe");
    try {
        await rm(dir, { recursive: true, force: true });
        for (const part of ["lower", "upper", "work", "merged"]) {
            await mkdir(join(dir, part), { recursive: true });
        }
        await execFileAsync("unshare", ["--mount", "--propagation", "private", "sh", "-c", probeScript(dir)], { timeout: 5_000 });
        return true;
    } catch {
        return false;
    } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
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

/* WHERE A TURN WORKS, and how strongly that is enforced — the two halves the turn hands to the harness.
 *
 * `plan` is the mapping and is always present for an isolated turn. `anchor` is present only when the
 * container could build the namespace to enforce it; without one the turn still runs cwd'd in its worktree
 * and worktree-redirect.ts rewrites the paths that would otherwise reach the shared tree. Carried as one
 * value because every consumer needs both answers together, and the pair is what makes "isolated but
 * unenforced" a state the code can see instead of an absence it has to infer.
 */
export interface TurnPlacement {
    readonly plan: IsolationPlan;
    readonly anchor?: IsolationAnchor;
}

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
    /* WHERE the conversation's worktree sits relative to the workspace root — answered whatever this container
     * can enforce, because the mapping is a fact about the layout and not about the kernel. Which layer
     * applies it is the caller's decision: an anchor when the namespace can be built, the tool-input rewrite
     * in worktree-redirect.ts when it cannot. Returning undefined here (as this once did) collapsed those two
     * questions into one, and the answer to the second was silently "nothing at all". */
    readonly planFor: (worktree: string) => Promise<IsolationPlan>;
    // Whether the namespace itself can be built — read by worktree creation to choose mount points over
    // symlinks, and by the turn to choose between the two enforcement layers above.
    readonly available: () => Promise<boolean>;
}

export const createTurnIsolation = (options: { readonly root: string; readonly historyRoot: string; readonly logger: Logger }): TurnIsolation => {
    const { root, historyRoot, logger } = options;
    // Probed once per daemon life: the answer is a property of how the container was launched, and re-probing
    // would spawn a process on every turn to re-learn it.
    let probe: Promise<boolean> | undefined;
    const available = (): Promise<boolean> => {
        probe ??= isolationAvailable(historyRoot).then((ok) => {
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
        // Re-read per turn rather than cached: an install that finished since the last turn has to be visible,
        // and this is one cheap directory walk against a warm dentry cache. Run even when the namespace is
        // unavailable — the redirect needs the same dependency dirs the mounts would have re-bound.
        // The conversation id is the worktree's own directory name (worktrees.ts owns that layout), so the
        // overlay scratch is derived from it rather than threaded separately — and the teardown paths there
        // reclaim the same path with the same helper.
        planFor: async (worktree) => ({ worktree, root, modules: await modulesDirs(root), overlays: overlaysDir(historyRoot, basename(worktree)) }),
    };
};

// The root-relative subtrees that mean the MAIN checkout on both sides of the boundary — the namespace binds
// them back in over the worktree's own copies, and where it cannot be built (worktree-redirect.ts) the
// worktree reaches them through symlinks. Either way a path into one of these is already correct, so the rule
// lives here rather than in a copy per caller.
const sharedPrefixes = (plan: IsolationPlan): string[] => [SHARED_STATE, ...plan.modules.map((pkg) => (pkg === "" ? MODULES : `${pkg}/${MODULES}`))];

/* WHICH FILE A WORKSPACE PATH ACTUALLY NAMES for an isolated turn — one mapping, used by both layers that
 * need it, because they are the same question asked from opposite ends:
 *
 *  - the DAEMON, translating a path the agent REPORTED. It lives outside the namespace, so the agent's
 *    `/work/intentic/x.ts` names the main checkout from here — the wrong file with the right name. The
 *    post-edit diagnostics (which would otherwise type-check the main tree's copy), the tool-call location
 *    chips and the transcript's edit diffs all resolve through this.
 *  - the TOOL CALL, when there is no namespace to make the path true by itself (worktree-redirect.ts). The
 *    agent ASKS for `/work/intentic/x.ts` and the write has to land where the namespace would have put it.
 *
 * Only the root prefix moves. A path outside the workspace root (a memory file under ~, /tmp scratch) is the
 * same file either way and is returned untouched, as is anything under sharedPrefixes — those subtrees are
 * the main checkout on both sides, so moving them would name a file the worktree does not have.
 */
export const inWorktree = (path: string, plan: IsolationPlan | undefined): string => {
    if (plan === undefined || (path !== plan.root && !path.startsWith(`${plan.root}/`))) {
        return path;
    }
    const rel = path === plan.root ? "" : path.slice(plan.root.length + 1);
    if (sharedPrefixes(plan).some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) {
        return path;
    }
    // The root itself is the worktree root: `ls /work` must list the agent's own tree, not the shared one.
    return rel === "" ? plan.worktree : join(plan.worktree, rel);
};
