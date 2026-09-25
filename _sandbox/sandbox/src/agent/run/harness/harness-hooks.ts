import { isAbsolute, join } from "node:path";
import type { AgentTurn, ModelPin, Rule, SandboxSettings } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { fromWorktree, inWorktree, type IsolationAnchor, nsenterPrefix } from "../../../conversations/worktrees/isolation.js";
import type { Services } from "../../../composition.js";
import { dirtyPathsAcross } from "../../../git/changes/changes.js";
import type { CommandGuardOptions } from "../../../guard/command-guard.js";
import { editBytesReviewer } from "../../../rules/edit-bytes.js";
import { fileEditedReviewer, spawnEditCommand } from "../../../rules/file-edited.js";
import { repoCwd } from "../../../rules/rule-cwd.js";
import { workspaceRelative } from "../../../rules/workspace-relative.js";
import { discoverRepos } from "../../../workspace/layout/repo-discovery.js";
import type { TurnContext } from "../../providers/adapter.js";
import type { TurnHooks } from "../../providers/agent-request.js";
import { opt } from "../../../opt.js";

// What the daemon answers while a turn runs: the checks at every edit, the safety judge and its log, and the ledgers a
// turn feeds. Nothing runs when the turn ends: the model decides when it is done, and the whole-tree check runs after
// its work lands (workspace/deps/verify-deps.ts). Every write here is best-effort, since the turn must settle regardless.

// What the harness's hooks reach for: the per-edit reviewers' deps, the ledgers they stamp, and the judge.
export type HarnessHooksDeps = Pick<
    Services,
    "workspace" | "logger" | "ruleFirings" | "judgeCommand" | "runtimeInstalls" | "safetyLog" | "safetyPolicy"
>;

// A rule's command inside the turn's own namespace via nsenter, since the daemon-side worktree has empty dependency
// directories; `repo` is carried this far because inside the namespace `--wdns`, not the cwd, decides where it runs.
export const ruleCommandIn = (command: string, anchor: IsolationAnchor | undefined, repo?: string): string =>
    anchor === undefined ? command : `${nsenterPrefix(anchor.pid, repoCwd(anchor.cwd, repo))}bash -c ${shellQuote(command)}`;

// A closure over the judge, the policy text and the owner's model pin rather than any of them directly, because the seam
// it fills lives in guard/.
const judgeFor =
    (deps: Pick<Services, "judgeCommand">, policy: string, pins: readonly ModelPin[] | undefined): CommandGuardOptions["judge"] =>
    (program, facts, signal) =>
        // An unpinned role reads as an empty list, which the walk answers with its Auto ladder.
        deps.judgeCommand({ policy, program, facts, pins: pins ?? [] }, signal);

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

// The `file.edited` moment: the byte scan on every written file, then each repository's own edit checks, run in the
// turn's own tree and named as the agent sees it. Firings stamp the settings list only, so a per-edit check
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
    });
    return { editReviewers: [bytes, commands].filter((each) => each !== undefined) };
};

// The judge and its writes: snapshots taken here, for one document and one model per turn.
const safetyHooksOf = (deps: HarnessHooksDeps, settings: SandboxSettings, safetyPolicy: string): Omit<TurnHooks, "cards"> => ({
    judge: judgeFor(deps, safetyPolicy, settings.modelRoles[`safety-judge`]),
    // The safety log is the owner's record of what the judge decided; a line it could not keep is said out loud.
    logSafety: (entry) => {
        void deps.safetyLog.record(entry).catch((error: unknown) => deps.logger.warn({ err: error }, "safety log: a judged command was not recorded"));
    },
    safetyAnswered: (at, answer, outcome) => {
        void deps.safetyLog.answered(at, answer, outcome).catch((error: unknown) => deps.logger.warn({ err: error }, "safety log: the owner's answer was not recorded"));
    },
    rememberSafety: (line) => deps.safetyPolicy.append(line),
});

// Milliseconds a turn reuses its checkout's repo list: discovery walks up to 10k dirs, and every shell command asks.
const REPOS_REUSED_MS = 60_000;

// The turn's dirty files for shell-edit attribution, with the repo list walked at most once per REPOS_REUSED_MS.
const dirtyFilesOf = (context: TurnContext): (() => Promise<readonly { readonly onDisk: string; readonly path: string }[]>) => {
    let repos: { readonly at: number; readonly list: Promise<string[]> } | undefined;
    return async () => {
        const now = Date.now();
        if (repos === undefined || now - repos.at > REPOS_REUSED_MS) {
            repos = { at: now, list: discoverRepos(context.localCwd) };
        }
        return (await dirtyPathsAcross(context.localCwd, await repos.list)).map((path) => {
            const onDisk = join(context.localCwd, path);
            return { onDisk, path: fromWorktree(onDisk, context.base.spec.isolation?.plan) };
        });
    };
};

// Every hook a harness turn is planned with, on top of the ones the route and the planner already bound.
export const harnessHooks = (
    deps: HarnessHooksDeps,
    input: AgentTurn,
    context: TurnContext,
    fileEdited: readonly Rule[],
    safety: { readonly settings: SandboxSettings; readonly policy: string },
): TurnHooks => ({
    ...context.base.hooks,
    // Every image-scoped install attempt, appended best-effort to the runtime-install ledger; a second distinct session
    // installing the same tool is what earns an auto-drafted overlay step.
    onImageInstall: (installs, command) => {
        void deps.runtimeInstalls
            .record(installs, command, input.conversationId, Date.now())
            .catch((error: unknown) => deps.logger.warn({ err: error }, "runtime-install ledger append failed"));
    },
    // Which files the tree says are dirty, both names, for a shell command's edit diagnostics. Read on every turn: the
    // main checkout's standing dirty set is everyone's landed work and a baseline, not a finding, there.
    dirtyFiles: dirtyFilesOf(context),
    ...editReviewersOf(deps, context, fileEdited),
    ...safetyHooksOf(deps, safety.settings, safety.policy),
    // The rebase the cards take back while the user is answering them; isolated turns only.
    ...opt("resync", context.resync),
});
