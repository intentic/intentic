import { isAbsolute, join } from "node:path";
import type { Rule } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { landingPaths } from "../../../conversations/land/landing-paths.js";
import { isIsolated } from "../../../conversations/registry/agents-store.js";
import { fromWorktree, inWorktree, type IsolationAnchor, ownWorktree } from "../../../conversations/worktrees/isolation.js";
import { namespaceTargetOf, nsenterPrefix } from "../../../workload/namespace-entry.js";
import type { Services } from "../../../composition.js";
import { editBytesReviewer } from "../../../rules/edit-bytes.js";
import { fileEditedReviewer, spawnEditCommand } from "../../../rules/file-edited.js";
import { installedCopyDirtyPaths, installedCopyReviewer } from "./installed-copy.js";
import { repoCwd } from "../../../rules/rule-cwd.js";
import { reposOf } from "../../../rules/rules.js";
import { workspaceRelative } from "../../../rules/workspace-relative.js";
import { discoverRepos } from "../../../workspace/layout/repo-discovery.js";
import type { TurnContext } from "../../providers/adapter.js";
import { checkoutDirtyPaths } from "../../tools/agent-shell-edits.js";
import type { TurnHooks } from "../../providers/agent-request.js";
import type { TurnChange } from "../turn-checks.js";
import { opt } from "../../../opt.js";

// What the daemon answers while a Claude Code turn runs: the checks at every edit, the repositories' `turn` checks once
// as an isolated turn is about to stop (run/turn-checks.ts), and the ledgers they stamp. The safety judge, its log and
// the install rule are every runtime's (run/turn/turn-safety.ts). No check holds the turn: the model decides when it is
// done, and CI checks what the owner pushes. Every write here is best-effort, since the turn must settle regardless.

// What the harness's hooks reach for: the reviewers' deps, the conversation's checkout for what its work changed, and
// the ledgers they stamp.
export type HarnessHooksDeps = Pick<
    Services,
    "workspace" | "logger" | "ruleFirings" | "agents" | "agentWorktrees" | "perf" | "capabilities" | "config"
>;

// A rule's command inside the turn's own namespace via nsenter, since the daemon-side worktree has empty dependency
// directories; `repo` is carried this far because inside the namespace `--wdns`, not the cwd, decides where it runs.
export const ruleCommandIn = (command: string, anchor: IsolationAnchor | undefined, repo?: string): string =>
    anchor === undefined ? command : `${nsenterPrefix(namespaceTargetOf(anchor), repoCwd(anchor.cwd, repo))}bash -c ${shellQuote(command)}`;

// Stamps a rule's firing on the settings list; best-effort, so a failed stamp costs the rule its date, not the turn.
const stampFiring = (deps: Pick<Services, "logger" | "ruleFirings">, rule: Rule): void => {
    void deps.ruleFirings
        .stamp(rule.id, Date.now())
        .catch((error: unknown) => deps.logger.warn({ err: error, rule: rule.id }, "rule firing stamp failed"));
};

// A path under one of the tree's roots, as the tree names it; undefined for one outside all of them.
const underRoots = (file: string, roots: readonly string[]): string | undefined => {
    if (!isAbsolute(file)) {
        return file;
    }
    return roots.map((root) => workspaceRelative(file, root)).find((relative) => relative !== file);
};

// The `file.edited` moment: the byte scan on every written file, the note on a write into a copy of an extension the
// sandbox runs (installed-copy.ts), then each repository's own edit checks, run in the turn's own tree and named
// as the agent sees it. Firings stamp the settings list only, so a per-edit check
// doesn't spam a feed row per save.
const editReviewersOf = (deps: HarnessHooksDeps, context: TurnContext, rules: readonly Rule[]): Pick<TurnHooks, "editReviewers"> => {
    const isolation = context.base.spec.isolation;
    const roots = [context.localCwd, isolation?.plan?.root, deps.workspace.root].filter((root): root is string => root !== undefined);
    // Read by the daemon itself, so an isolated turn's file is its worktree's copy whether or not a namespace is entered.
    const bytes = editBytesReviewer({ onDisk: (file) => inWorktree(file, isolation?.plan), relative: (file) => underRoots(file, roots) });
    const commands = fileEditedReviewer(rules, {
        // In the repository the rule named, as at every other moment; the file itself travels as an absolute path, so
        // where the command runs changes without what it is given changing.
        run: (command, timeoutMs, repo) =>
            spawnEditCommand(repoCwd(context.localCwd, repo))(ruleCommandIn(command, isolation?.anchor, repo), timeoutMs),
        repos: () => discoverRepos(context.localCwd),
        roots,
        place: (file) => (isolation?.anchor === undefined ? inWorktree(file, isolation?.plan) : file),
        onFired: (rule: Rule) => stampFiring(deps, rule),
        onRan: (rule, ms, status) => deps.perf.record("edit.rule", ms, { rule: rule.id, status }, status === "error"),
    });
    // Installs live in the shared tree, outside every worktree, so they are looked up from the workspace root.
    const installed = installedCopyReviewer({
        root: deps.workspace.root,
        bakedRoot: () => deps.config.extensionsDir,
        capabilities: () => deps.capabilities.list(),
        relative: (file) => underRoots(file, roots),
    });
    return { editReviewers: [bytes, installed, commands].filter((each) => each !== undefined) };
};

// What the conversation's work changed and has not landed in the repositories `named`, workspace-relative, and the
// repositories that holds: the same reading its land takes (landing-paths.ts), so a file the turn committed in its
// worktree counts as one it left uncommitted, and scratch no land carries counts as neither. Only the repositories a
// check names are read, since a change anywhere else matches no check.
const turnChangeOf = async (deps: HarnessHooksDeps, conversationId: string, named: ReadonlySet<string>): Promise<TurnChange> => {
    const entry = deps.agents.entry(conversationId);
    if (entry === undefined || !isIsolated(entry)) {
        return { paths: [], repos: [] };
    }
    const paths = await landingPaths(
        deps,
        entry,
        entry.placement.repos.filter(({ repo }) => named.has(repo)),
    );
    const nested = entry.placement.repos.map(({ repo }) => repo).filter((repo) => repo !== "root");
    return { paths, repos: reposOf(paths, nested) };
};

// The `turn.ending` moment: each repository's own `turn` checks, run once as an isolated turn is about to stop, in the
// repository they name in the turn's own tree and through its namespace, as the edit checks are. Isolated turns only: a
// main-tree turn's working tree carries everyone's uncommitted work, and a check of it would charge the turn with theirs.
const turnChecksOf = (deps: HarnessHooksDeps, context: TurnContext, rules: readonly Rule[]): Pick<TurnHooks, "turnChecks"> => {
    const isolation = context.base.spec.isolation;
    const conversationId = context.base.spec.conversationId;
    if (rules.length === 0 || !ownWorktree(isolation) || conversationId === undefined) {
        return {};
    }
    const named = new Set(rules.flatMap((rule) => (rule.when?.repo === undefined ? [] : [rule.when.repo])));
    return {
        turnChecks: {
            rules,
            change: () => turnChangeOf(deps, conversationId, named),
            // With the turn's shell variables, its connector cards' among them: a turn check stands where the turn's last
            // command stood, so what the turn could reach, its check can (the shared turbo cache's warmer needs its card).
            run: (command, timeoutMs, repo) =>
                spawnEditCommand(repoCwd(context.localCwd, repo), context.cliEnv)(ruleCommandIn(command, isolation.anchor, repo), timeoutMs),
            // A firing date on the settings list, as an edit check's; a feed row per turn would be noise.
            onFired: (rule) => stampFiring(deps, rule),
            logger: deps.logger.child({ conversationId }),
        },
    };
};

// The turn's dirty files for shell-edit attribution, by both names (checkoutDirtyPaths reuses the repo list), plus the
// installed extensions' checkouts: they sit in the shared tree under a hidden directory no repo walk enters, and a
// build or `sed -i` there is exactly the write the installed-copy note exists for. Same name on both sides, since the
// shared tree is mounted at the same path inside a turn's namespace.
const dirtyFilesOf = (
    deps: HarnessHooksDeps,
    context: TurnContext,
): (() => Promise<readonly { readonly onDisk: string; readonly path: string }[]>) => {
    const dirty = checkoutDirtyPaths(context.localCwd);
    const installs = installedCopyDirtyPaths(deps.workspace.root);
    return async () => [
        ...(await dirty()).map((path) => {
            const onDisk = join(context.localCwd, path);
            return { onDisk, path: fromWorktree(onDisk, context.base.spec.isolation?.plan) };
        }),
        ...(await installs().catch((): string[] => [])).map((path) => ({ onDisk: join(deps.workspace.root, path), path })),
    ];
};

// Every hook a harness turn is planned with, on top of the ones the route and the planner already bound.
export const harnessHooks = (deps: HarnessHooksDeps, context: TurnContext, fileEdited: readonly Rule[], turnEnding: readonly Rule[]): TurnHooks => ({
    ...context.base.hooks,
    // Which files the tree says are dirty, both names, for a shell command's edit diagnostics. Read on every turn: the
    // main checkout's standing dirty set is everyone's landed work and a baseline, not a finding, there.
    dirtyFiles: dirtyFilesOf(deps, context),
    ...editReviewersOf(deps, context, fileEdited),
    ...turnChecksOf(deps, context, turnEnding),
    // Each hook callback's time, filed under `hook.<event>`: slow ones land in perf.jsonl with the tool they held.
    hookTimed: (event, ms, timing) =>
        deps.perf.record(`hook.${event}`, ms, {
            matcher: timing.matcher,
            at: timing.at,
            tool: timing.tool,
            conversation: context.base.spec.conversationId,
        }),
    // The rebase the cards take back while the user is answering them; isolated turns only.
    ...opt("resync", context.resync),
});
