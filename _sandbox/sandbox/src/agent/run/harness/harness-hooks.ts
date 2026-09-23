import { isAbsolute, join } from "node:path";
import type { AgentTurn, ModelPin, Rule, SandboxSettings } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { fromWorktree, inWorktree, type IsolationAnchor, nsenterPrefix } from "../../../agents/worktrees/isolation.js";
import type { Services } from "../../../composition.js";
import { dirtyPathsAcross, turnPathsAcross } from "../../../git/changes/changes.js";
import type { CommandGuardOptions } from "../../../guard/command-guard.js";
import { editBytesReviewer } from "../../../rules/edit-bytes.js";
import { fileEditedReviewer, spawnEditCommand } from "../../../rules/file-edited.js";
import { type RuleCommandDeps, type RuleCommandRun, runRuleCommand } from "../../../rules/rule-command.js";
import { repoCwd } from "../../../rules/rule-cwd.js";
import { type FollowUpOutcome, workspaceRelative } from "../../../rules/turn-ending.js";
import { CHECKS_SESSION } from "../../../terminal/terminal-session.js";
import { discoverRepos } from "../../../workspace/layout/repo-discovery.js";
import type { TurnContext } from "../../providers/adapter.js";
import type { TurnHooks } from "../../providers/agent-request.js";
import { checkRunOf } from "../../verification/turn-checks.js";
import { opt } from "../../../opt.js";

// What the daemon answers while a turn runs: the checks at every edit and at the Stop, the safety judge and its log, and
// the ledgers a turn feeds. Every write here is best-effort, since the turn must settle regardless.

// What the turn-end hooks reach for, on every runtime: the rule runner's own deps and the ledgers they write.
export type TurnEndingHooksDeps = RuleCommandDeps & Pick<Services, "activity" | "conversations" | "dependencies" | "ruleFirings">;

// What the harness's hooks reach for: the turn-end hooks' deps, the per-edit reviewers', and the judge.
export type HarnessHooksDeps = TurnEndingHooksDeps & Pick<Services, "judgeCommand" | "runtimeInstalls" | "safetyLog" | "safetyPolicy">;

// Bytes of a failed turn-ending command's output forwarded to the model; smaller than the pre-push budget since this
// turn is still running and only needs enough to act on.
const TURN_RULE_OUTPUT_BYTES = 4_000;

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

// The `file.edited` moment: the byte scan on every written file, then each repository's own edit checks, run where the
// Stop's command would run and named as the agent sees it. Firings stamp the settings list only, so a per-edit check
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

// A rule that fires at the Stop continued a turn the model had finished; stamped to the settings list and the feed.
const ruleFiredAt =
    (deps: TurnEndingHooksDeps, input: AgentTurn) =>
    (rule: Rule): void => {
        stampFiring(deps, rule);
        void deps.activity
            .append({
                direction: "system",
                type: "rule.continued_turn",
                content: `"${rule.label}" asked for one more thing before this turn could finish.`,
                ...opt("conversationId", input.conversationId),
            })
            .catch((error: unknown) => deps.logger.warn({ err: error, rule: rule.id }, "rule activity append failed"));
    };

// What a follow-up bought, in counts, so the rule's cost can be weighed against what it changed.
const followUpAt =
    (deps: TurnEndingHooksDeps, input: AgentTurn) =>
    (rule: Rule, outcome: FollowUpOutcome): void => {
        const did = [
            outcome.edits > 0 ? `${outcome.edits} edit${outcome.edits === 1 ? "" : "s"}` : undefined,
            outcome.looks > 0 ? `${outcome.looks} look${outcome.looks === 1 ? "" : "s"} at the page` : undefined,
            outcome.commands > 0 ? `${outcome.commands} command${outcome.commands === 1 ? "" : "s"}` : undefined,
        ].filter((part) => part !== undefined);
        void deps.activity
            .append({
                direction: "system",
                type: "rule.followup_outcome",
                content: `"${rule.label}" was answered with ${did.length === 0 ? "no edit, no look and no command" : did.join(", ")}.`,
                extra: { rule: rule.id, ...outcome },
                ...opt("conversationId", input.conversationId),
            })
            .catch((error: unknown) => deps.logger.warn({ err: error, rule: rule.id }, "rule outcome append failed"));
    };

// Logged like the pre-push check, since a red `turn.ending` command has two very different causes (broken work, or a
// check that never saw the workspace's dependencies) told apart only by whether it ran anchored in the turn's namespace.
const ruleRunnerIn =
    (deps: TurnEndingHooksDeps, context: TurnContext): NonNullable<TurnHooks["runRuleCommand"]> =>
    async (command, timeoutMs, repo) => {
        const anchor = context.base.spec.isolation?.anchor;
        const from = Date.now();
        // A rule naming a repository runs inside it, in this turn's own tree: for an isolated turn that is its
        // worktree's copy of the repository, not the one on /work.
        const cwd = repoCwd(context.localCwd, repo);
        deps.logger.info({ command, anchored: anchor !== undefined, cwd, session: CHECKS_SESSION }, "checks: check started");
        const run = await runRuleCommand(deps, {
            command: ruleCommandIn(command, anchor, repo),
            timeoutMs,
            cwd,
            session: CHECKS_SESSION,
            window: "checks",
            outputBytes: TURN_RULE_OUTPUT_BYTES,
        });
        deps.logger.info(
            {
                command,
                anchored: anchor !== undefined,
                status: run.status,
                ...opt("exitCode", run.exitCode),
                ...(run.timedOut === true ? { timedOut: true } : {}),
                durationMs: Date.now() - from,
            },
            "checks: check settled",
        );
        return run;
    };

// What the tree says an isolated turn changed. Only there: its branch holds nothing but its own work since the
// main-line base, while the main checkout's dirty set is everyone's.
const isolatedStopHooks = (deps: TurnEndingHooksDeps, context: TurnContext): Pick<TurnHooks, "changedPaths"> =>
    context.localCwd === deps.workspace.root
        ? {}
        : { changedPaths: async () => turnPathsAcross(context.localCwd, await discoverRepos(context.localCwd)) };

// Everything the Stop reads when `turn.ending` rules stand, whichever runtime runs it (the Claude Code loop's own Stop
// hook, or the daemon's after the frames end); nothing at all when none do, so no hook is wired.
export const turnEndingHooksOf = (
    deps: TurnEndingHooksDeps,
    input: AgentTurn,
    context: TurnContext,
    rules: readonly Rule[],
): Omit<TurnHooks, "cards"> => {
    if (rules.length === 0) {
        return {};
    }
    const conversation = input.conversationId;
    return {
        // The verdict goes to the conversation's actor, which keeps the card's line and the land's verdict apart: the land
        // takes its copy once, the card goes on reading its own.
        ...(conversation === undefined
            ? {}
            : {
                  onCheckRun: (rule: Rule, run: RuleCommandRun) =>
                      void deps.conversations.send(conversation, { kind: "check-ran", check: checkRunOf(rule, run) }),
              }),
        onRuleFired: ruleFiredAt(deps, input),
        onFollowUpOutcome: followUpAt(deps, input),
        runRuleCommand: ruleRunnerIn(deps, context),
        // Asked only after a command has failed, so a healthy turn pays nothing: a check run mid-install isn't a verdict.
        dependencyInstalling: async () =>
            (await deps.dependencies.status())
                .filter((project) => project.state === "installing")
                .map((project) => (project.dir === "" ? "the workspace root" : project.dir)),
        // Asked at the Stop and only when a rule aimed at a repository stands (turn-ending.ts touchedRepos).
        turnRepos: () => discoverRepos(context.localCwd),
        ...isolatedStopHooks(deps, context),
    };
};

// The judge and its writes: snapshots taken here, for one document and one model per turn.
const safetyHooksOf = (deps: HarnessHooksDeps, settings: SandboxSettings, safetyPolicy: string): Omit<TurnHooks, "cards"> => ({
    judge: judgeFor(deps, safetyPolicy, settings.modelRoles[`safety-judge`]),
    logSafety: (entry) => {
        void deps.safetyLog.record(entry).catch(() => undefined);
    },
    safetyAnswered: (at, answer, outcome) => {
        void deps.safetyLog.answered(at, answer, outcome).catch(() => undefined);
    },
    rememberSafety: (line) => deps.safetyPolicy.append(line),
});

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
    dirtyFiles: async () =>
        (await dirtyPathsAcross(context.localCwd, await discoverRepos(context.localCwd))).map((path) => {
            const onDisk = join(context.localCwd, path);
            return { onDisk, path: fromWorktree(onDisk, context.base.spec.isolation?.plan) };
        }),
    ...editReviewersOf(deps, context, fileEdited),
    ...safetyHooksOf(deps, safety.settings, safety.policy),
    // The rebase the cards take back while the user is answering them; isolated turns only.
    ...opt("resync", context.resync),
});
