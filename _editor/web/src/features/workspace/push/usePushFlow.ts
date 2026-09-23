import {
    type AgentHarness,
    type AgentProvider,
    type AgentSummary,
    type CommandRun,
    commandRunOutcome,
    type FixAttemptPlan,
    type FixResume,
    type FixStance,
    fixStance,
    latestFixAttempt,
    modelPinKey,
    planFixAttempt,
    type PushRun,
    pushFixConversationId,
    type RepoChecksSummary,
} from "@intentic/sandbox-contract";
import type { AgentRunAttempt, AgentRunChoice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { sandboxRef, sandboxScopeGuard, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { computed, watch } from "vue";
import { stopAgent } from "../../agents/fleet/agentActions";
import { composeSession, startSession } from "../../agents/fleet/sessionSuggestion";
import { open as openAgent } from "../../agents/fleet/useAgents-actions";
import { archive } from "../../agents/fleet/useAgents-archive";
import { archived, loadArchived, registry } from "../../agents/fleet/useAgents-registry";
import { modelLabelFor } from "../../chat/accounts/providerCatalog";
import { useRoleModel } from "../../chat/accounts/roleModel";
import type { Conversation } from "../../chat/session/conversation";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { adoptedChecksFor, prepushCommandOf, pushChecksOf } from "../../sandbox/environment/rules";
import { useRepoChecks } from "../../sandbox/environment/useRepoChecks";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { checkFixPrompt, checkNudgePrompt, checkOutcome, fixSignature, outcomeSummary, pushFixPrompt, pushNudgePrompt } from "../health/fixProposal";
import { type SyncTarget, useChanges } from "../changes/useChanges";
import { workspaceChangedSince } from "../changes/live/useWorkspaceLive";
import { usePrepush } from "./usePrepush";
import { usePushRun } from "./usePushRun";
import { t } from "@intentic/ui/i18n";

// The push flow, from click to answer, kept at module level (not in the panel) so it outlives the surface
// that started it: any view calling this gets the same instance. `askSync` is the one door every push goes
// through; useChanges exports no single-repo push, so there's no way around the check.
//
// - a click is an instruction: a green check sends it without asking again, whether anyone's watching or not.
// - while running, the surface says so in place, and the rail says so from anywhere else; no dialog, since
//   there's nothing to decide yet.
// - only a red outcome raises `question`, wherever the user is (pushed to their devices too, if they've left;
//   prepush/prepush.ts).
// - nothing is lost by walking away: the question and the fix proposal wait until they're answered.
// - closing the card is "off my screen", not "that never happened": the verdict stands (`standing`), the panel says
//   so, and the same card comes back on a press. What retires it is the world changing, never a timer.
// - a failure has ATTEMPTS, and at most one live one (planFixAttempt): the card shows what became of the latest,
//   a press continues an ended one or opens the next, and never silently resumes a session the reader believed
//   they were replacing.

// What's about to leave, named the way the control that asked for it was labelled, so the flow echoes the
// click ("Publish", "Sync") instead of renaming it "Push".
export interface PendingPush {
    readonly verb: string;
    // What is going out, e.g. "3 commits across 2 repos", "intentic's branch".
    readonly what: string;
    readonly targets: readonly SyncTarget[];
}

// What a fix conversation's derived name is scoped to: this push's repos, sorted so order doesn't matter.
// Failing gates alone wouldn't do, since two workspaces can share the same three gates.
const scopeOf = (push: PendingPush): string =>
    [...new Set(push.targets.map((target) => target.repo))].sort((left, right) => left.localeCompare(right)).join(`-`);

// Which half of the flow is in flight; undefined the moment it settles, since nothing is running while a
// question waits.
export type PushStage = "checking" | "pushing";

// An outcome the user must answer, raised only for red; a pass phrased as a question is what earned the old
// dialog its bad reputation.
export interface PushQuestion {
    // Four words at most, read at a glance from a view the user may have walked back into.
    readonly title: string;
    // The command, in the monospace it wears mid-run; absent when several repos refused at once or nothing ran.
    readonly command?: string;
    // The predicate that follows it: what happened, in prose.
    readonly detail: string;
    // `checks` still has a push to send; `push` is the send itself refused, so the same button retries it.
    readonly kind: "checks" | "push";
}

// How long the panel says "Pushed": long enough to catch on the way back, short enough not to linger.
const PUSHED_NOTE_MS = 8_000;

// The first command the repositories going out contribute themselves (their own `.intentic/checks.json`, switched on by
// the owner); empty when none of them does.
const declaredPushCommand = (summaries: readonly RepoChecksSummary[], repos: readonly string[]): string =>
    adoptedChecksFor(summaries, `push`, repos)
        .flatMap((entry) => entry.checks)
        .find((check) => check.when === `push`)?.run ?? ``;

// Everything below names commits and runs in one sandbox's /work; offering to send them from another is the most
// consequential thing a switch could carry over, so all of it is sandbox-scoped.
const pending = sandboxShallowRef<PendingPush | undefined>(() => undefined);
const stage = sandboxRef<PushStage | undefined>(() => undefined);
// When the stage began; taken from the client, not the run, so check and push halves share one clock.
const since = sandboxRef(() => 0);
const question = sandboxShallowRef<PushQuestion | undefined>(() => undefined);
/* THE FIX A RED VERDICT PROPOSES: the failure it answers (its derived id, which attempt 1 wears), the opening prompt a fresh attempt gets. */
export interface FixProposal {
    readonly base: string;
    readonly prompt: string;
    readonly nudge: string;
}

// The failure's live attempt as the fleet reports it: what the card's slot shows, and what a press is about.
export interface FixAttemptState {
    readonly agent: AgentSummary;
    readonly attempt: number;
    readonly stance: FixStance;
}

/* THE RED VERDICT THAT OUTLIVES ITS CARD. */
export interface StandingVerdict {
    readonly push: PendingPush;
    readonly question: PushQuestion;
    readonly fix?: FixProposal;
    readonly runs: readonly PushRun[];
    // The settled check behind a `checks` verdict; absent for a refused send, whose runs are above. Only a `failed`
    // one is an answer worth reprinting: `error` and `cancelled` measured nothing, so a press means run it.
    readonly check?: CommandRun;
    // When it settled. What the panel counts from, and what a write to the tree is compared against.
    readonly at: number;
}

const proposedFix = sandboxShallowRef<FixProposal | undefined>(() => undefined);
const standing = sandboxShallowRef<StandingVerdict | undefined>(() => undefined);
// Whether the card on screen is a verdict being reprinted rather than one that just landed; the card says so, since
// "Checks failed" reads as news and this is not news.
const fromMemory = sandboxRef(() => false);
// A press in flight: stopping and filing away the attempt before it, then opening the next. The button waits on it.
const fixBusy = sandboxRef(() => false);
// Why the last press could not start anything, in the daemon's words; cleared by the next press.
const fixError = sandboxRef<string | undefined>(() => undefined);
// Push runs that settled red behind a `push` question: the terminal each ran in and the tail the fix quotes.
const refusedRuns = sandboxShallowRef<readonly PushRun[]>(() => []);
const pushed = sandboxShallowRef<PendingPush | undefined>(() => undefined);
// Expires the "Pushed" note; a switch takes the note down with its timer.
const pushedTimer = sandboxValue<ReturnType<typeof setTimeout> | undefined>(
    () => undefined,
    (timer) => clearTimeout(timer),
);

// Agent settings when the button was pressed, carried since the proposal may compose minutes later, unmounted.
const fixWith = sandboxValue<{ model?: string; effort?: string }>(() => ({}));

// Git actions, captured once from a mounted surface. Only useChanges's module-level halves (syncAll, actionBusy,
// failures) are read here; the query-backed halves are the panel's own.
let git: ReturnType<typeof useChanges> | undefined;

const { activeSandboxId } = useSandbox();

// How long this suite usually takes, remembered per sandbox in localStorage, not the daemon, which keeps
// nothing about a check at rest.
const storageKey = (id: string): string => `intentic.prepushDuration.${id}`;

const readTypical = (id: string | undefined): number | undefined => {
    if (id === undefined) {
        return undefined;
    }
    try {
        const stored = Number(localStorage.getItem(storageKey(id)));
        return Number.isFinite(stored) && stored > 0 ? stored : undefined;
    } catch {
        // Storage may be unavailable (private mode); the readout degrades to elapsed-only.
        return undefined;
    }
};
const typicalMs = sandboxRef<number | undefined>(() => readTypical(activeSandboxId.value));

// Only a run that reached a verdict measures anything; a cancel or timeout is the clock cut short, and
// remembering it would teach the readout a duration no suite takes.
const rememberTypical = (run: CommandRun): void => {
    const { startedAt, finishedAt } = run;
    if (startedAt === undefined || finishedAt === undefined || (run.status !== `passed` && run.status !== `failed`) || run.timedOut === true) {
        return;
    }
    typicalMs.value = finishedAt - startedAt;
    const id = activeSandboxId.value;
    if (id === undefined) {
        return;
    }
    try {
        localStorage.setItem(storageKey(id), String(finishedAt - startedAt));
    } catch {
        // As above: the value still serves this page's lifetime.
    }
};

// Entering a stage supersedes whatever was being asked: a new push is a new question, and the last one's fix
// is about a verdict nobody's waiting on. The standing one goes with it — something is being measured again, so
// the old answer is about to be replaced rather than merely doubted.
const enter = (push: PendingPush, next: PushStage): void => {
    pending.value = push;
    stage.value = next;
    since.value = Date.now();
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
    fixError.value = undefined;
    standing.value = undefined;
    fromMemory.value = false;
};

/* Every red outcome raises the same question and records the same verdict material. */
const raise = (push: PendingPush, asked: PushQuestion, filed: Pick<StandingVerdict, "fix" | "runs" | "check" | "at">): void => {
    question.value = asked;
    proposedFix.value = filed.fix;
    refusedRuns.value = filed.runs;
    standing.value = { push, question: asked, ...filed };
    fromMemory.value = false;
};

// Back on screen, unchanged, at no cost: the same words, the same proposal, the same override. `push` is the press
// that asked for it, which may be carrying more commits than the one that failed; the verdict is about the tree,
// so it stands over either.
const reopen = (push?: PendingPush): void => {
    const held = standing.value;
    if (held === undefined) {
        return;
    }
    pending.value = push ?? held.push;
    question.value = held.question;
    proposedFix.value = held.fix;
    refusedRuns.value = held.runs;
    fixError.value = undefined;
    fromMemory.value = true;
};

/* A standing failed verdict is reused until the checked tree changes. */
const reusable = (): StandingVerdict | undefined => {
    const held = standing.value;
    return held?.check?.status === `failed` && !workspaceChangedSince(held.at) ? held : undefined;
};

// Back to rest, having sent what was asked; the note is the only thing left, and it expires on its own.
const done = (push: PendingPush): void => {
    pending.value = undefined;
    stage.value = undefined;
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
    // The work left the machine, so nothing about it is still owed; a verdict from before it would be a warning
    // about a push that has already gone.
    standing.value = undefined;
    fromMemory.value = false;
    usePrepush().forget();
    pushed.value = push;
    clearTimeout(pushedTimer.value);
    pushedTimer.value = setTimeout(() => (pushed.value = undefined), PUSHED_NOTE_MS);
};

// Waits for the busy git-action span useChanges holds during a commit/fetch/discard, since a push fired into
// it would be dropped silently; the user was invited to keep working, and the push must survive that.
const untilIdle = async (): Promise<void> => {
    if (git?.actionBusy.value !== true) {
        return;
    }
    await new Promise<void>((resolve) => {
        const stop = watch(git!.actionBusy, (busy) => {
            if (!busy) {
                stop();
                resolve();
            }
        });
    });
};

// Failures useChanges files per repo are the outcome; the batch carries on past a refusal. A refused push
// raises the same question a red check does, and proposes nothing when nothing is known to be wrong with the code.
const send = async (push: PendingPush): Promise<void> => {
    enter(push, `pushing`);
    usePrepush().forget();
    await untilIdle();
    // Another ask superseded this one while it waited; whatever the flow is about now, it isn't this.
    if (pending.value !== push) {
        return;
    }
    await git!.syncAll(push.targets);
    if (pending.value !== push) {
        return;
    }
    const refused = push.targets.map((target) => target.repo).filter((repo) => git!.failures.value.has(repo));
    if (refused.length === 0) {
        done(push);
        return;
    }
    stage.value = undefined;
    const runs = refused.map((repo) => git!.failures.value.get(repo)?.run).filter((run) => run !== undefined);
    const byHook = runs.filter((run) => run.refusedBy === `hook`);
    raise(push, refusalQuestion(push, refused), {
        runs,
        at: Date.now(),
        ...(byHook.length > 0
            ? {
                  fix: {
                      // One hook failure across several repos is one fix in one worktree, so it's one conversation.
                      base: pushFixConversationId(byHook.map((run) => run.repo).join(`-`), fixSignature(byHook.map((run) => run.output).join(`\n`))),
                      prompt: pushFixPrompt(byHook),
                      nudge: pushNudgePrompt(byHook),
                  },
              }
            : {}),
    });
};

// The question a refused send raises, from the failures useChanges filed against the repos that refused.
const refusalQuestion = (push: PendingPush, refused: readonly string[]): PushQuestion => {
    const only = refused.length === 1 ? git!.failures.value.get(refused[0]!) : undefined;
    if (only === undefined) {
        // Several can't share a line; each row in the panel already carries its own reason.
        return {
            kind: `push`,
            title: t(`workspace.usePushFlow.failed`, { verb: push.verb }),
            detail: t(`workspace.usePushFlow.reposRefusedEachRow`, { count: refused.length }),
        };
    }
    if (only.run === undefined) {
        // No run: a pull that failed ahead of the push, so the line names the repo itself.
        return { kind: `push`, title: t(`workspace.usePushFlow.failed`, { verb: push.verb }), detail: `${refused[0]}: ${only.detail}` };
    }
    // The run's own outcome names it; its command sits above the line, the predicate that follows, as a check's is.
    return { kind: `push`, title: commandRunOutcome(only.run, push.verb), command: only.run.command, detail: only.detail };
};

/* WHICH PUSH RUNS THE MOMENT IS ABOUT: the ones a send in flight is writing, or the ones a refusal filed. Only. */
const runsInQuestion = (): readonly ReturnType<typeof usePushRun>[] => {
    if (stage.value === `pushing`) {
        return (pending.value?.targets ?? []).filter((target) => target.push).map((target) => usePushRun(target.repo));
    }
    const refused = refusedRuns.value.length > 0 ? refusedRuns.value : (standing.value?.runs ?? []);
    return refused.map((run) => usePushRun(run.repo));
};

// The terminal the current moment is about: the check's while it runs, after refusing, and for as long as its
// verdict stands; the push's while running or after refusal. One button on every surface, pointed at whichever run
// is in question.
const currentTerminal = (): { readonly session: string; readonly show: () => void } | undefined => {
    const watcher = runsInQuestion().find((candidate) => candidate.terminal.value !== undefined);
    if (watcher !== undefined) {
        return { session: watcher.terminal.value!, show: watcher.showTerminal };
    }
    const prepush = usePrepush();
    const session = prepush.terminal.value;
    return session === undefined ? undefined : { session, show: prepush.showTerminal };
};

export function usePushFlow() {
    git ??= useChanges();
    const { settings } = useSandboxSettings();
    // What the repositories themselves ask for, beside what the owner wrote: both decide whether this push is checked.
    const { repos: declaringRepos } = useRepoChecks();
    // This job's own model list: a pre-push fix reads a failing check on work about to leave the machine.
    const prePushFix = useRoleModel(`pre-push-fix`);

    // Which repositories a press is sending, the question every check below is asked about.
    const pushedRepos = (push: PendingPush): string[] => [...new Set(push.targets.filter((target) => target.push).map((target) => target.repo))];

    // Whether anything at all stands before this push: a rule the owner wrote, or a check one of these repositories
    // declares for itself and the owner has switched on. Nothing standing means the push simply goes.
    const checksStandFor = (push: PendingPush): boolean => {
        const repos = pushedRepos(push);
        return pushChecksOf(settings.value?.rules ?? [], repos).length > 0 || adoptedChecksFor(declaringRepos.value ?? [], `push`, repos).length > 0;
    };

    // What the waiting line names while nothing has been polled yet: the first command standing for whatever push is in
    // question, the owner's rules ahead of a repository's own, since that is the order they run in.
    const firstCheckCommand = (): string => {
        const push = pending.value ?? standing.value?.push;
        const repos = push === undefined ? [] : pushedRepos(push);
        const owned = prepushCommandOf(settings.value?.rules ?? [], repos);
        return owned === `` ? declaredPushCommand(declaringRepos.value ?? [], repos) : owned;
    };

    // The one door every Push, Sync and Publish arrives at, so the check can't be walked around by another route.
    // A pull-only sync, or a workspace with no check configured, both pass straight through and still report their
    // outcome.
    const askSync = (verb: string, what: string, targets: readonly SyncTarget[]): void => {
        if (stage.value !== undefined) {
            return;
        }
        const push: PendingPush = { verb, what, targets };
        // The head of the pre-push-fix list, read early: a no-check push can still be hook-refused and reuse this.
        const head = prePushFix.choice.value;
        fixWith.value = head === undefined ? {} : { model: modelPinKey(head), effort: head.effort };
        // Asked of the repositories this press is actually sending: a rule aimed at one, and a repository's own
        // declared checks, stand only for their own. So a docs-only push is no longer gated by the app's suite.
        if (!checksStandFor(push) || !targets.some((target) => target.push)) {
            void send(push);
            return;
        }
        /* A RED VERDICT NOTHING HAS BEEN WRITTEN OVER IS STILL THE ANSWER, so this press reprints it instead. */
        if (reusable() !== undefined) {
            reopen(push);
            return;
        }
        runChecks(push);
    };

    /* Checks start only when no standing verdict is being reused. */
    function runChecks(push: PendingPush): void {
        enter(push, `checking`);
        // A check settling after a switch measured the sandbox left behind: its duration is not this one's to learn.
        const current = sandboxScopeGuard();
        void usePrepush()
            .start(pushedRepos(push))
            .then((settled) => {
                if (!current()) {
                    return;
                }
                rememberTypical(settled);
                if (pending.value !== push || stage.value !== `checking`) {
                    return;
                }
                if (settled.status === `passed`) {
                    void send(push);
                    return;
                }
                stage.value = undefined;
                raise(
                    push,
                    { kind: `checks`, title: checkOutcome(settled), command: settled.command, detail: outcomeSummary(settled) },
                    {
                        runs: [],
                        check: settled,
                        at: settled.finishedAt ?? Date.now(),
                        // `error` and `cancelled` propose no fix: either way nothing is known to be wrong with the code.
                        ...(settled.status === `failed`
                            ? {
                                  fix: {
                                      // Named after what failed, not this press: the check reruns each attempt, so a name
                                      // minted per press would hide from the card that an agent is already on this failure.
                                      base: pushFixConversationId(scopeOf(push), fixSignature(settled.output)),
                                      prompt: checkFixPrompt(settled),
                                      nudge: checkNudgePrompt(settled),
                                  },
                              }
                            : {}),
                    },
                );
            });
    }

    // The answer to a verdict the reader does not accept: run the suite over again, on the push that raised it or
    // the one they have just pressed. Drops the old verdict, since something is being measured again.
    const runAgain = (): void => {
        const push = pending.value ?? standing.value?.push;
        if (push !== undefined && stage.value === undefined) {
            runChecks(push);
        }
    };

    // Always available, during the run and after a failure, and never asks twice. A still-running check is left
    // running: killing it here would decide, for the user, that an answer they chose not to wait for is wanted by
    // nobody.
    const pushAnyway = (): void => {
        const push = pending.value;
        if (push !== undefined) {
            void send(push);
        }
    };

    /* Closing the card leaves the standing verdict and its run available. */
    const dismiss = (): void => {
        pending.value = undefined;
        stage.value = undefined;
        question.value = undefined;
        proposedFix.value = undefined;
        refusedRuns.value = [];
        fixError.value = undefined;
        fromMemory.value = false;
    };

    // The proposed failure's live attempt, read off the roster the stream keeps current. A landed attempt answered a
    // failure that is now history: the same gates red again is a new failure wearing the same name, and the slot
    // offers a fresh press rather than a chip about work already in the tree.
    const attemptOf = (): FixAttemptState | undefined => {
        const fix = proposedFix.value;
        const latest = fix === undefined ? undefined : latestFixAttempt(fix.base, registry.value);
        if (latest === undefined) {
            return undefined;
        }
        const stance = fixStance(latest.agent);
        return stance.kind === `landed` ? undefined : { agent: latest.agent, attempt: latest.attempt, stance };
    };

    // The same attempt as the picker's bar names it (AttemptOnOffer): which, on what, how it stands.
    const attemptOnOffer = (): AgentRunAttempt | undefined => {
        const held = attemptOf();
        if (held === undefined) {
            return undefined;
        }
        const { agent, attempt, stance } = held;
        const files = agent.diff?.files ?? 0;
        const summary = [
            `Attempt ${attempt}`,
            agent.model === undefined ? undefined : modelLabelFor(agent.provider, agent.model),
            stance.label.toLowerCase(),
            files === 0 ? undefined : `${files} file${files === 1 ? `` : `s`} on its branch`,
        ]
            .filter((part) => part !== undefined)
            .join(` · `);
        return { summary, continuable: stance.retry };
    };

    // The chip's press: the attempt's own conversation, wherever the chat panel is.
    const openAttempt = (): void => {
        const held = attemptOf();
        if (held !== undefined) {
            openAgent(held.agent);
        }
    };

    /* Only explicitly selected fields overwrite the fix draft. */
    const applyPick = (fix: Conversation, pick: AgentRunChoice): void => {
        fix.selection.apply({ kind: `selectModel`, pick: { provider: pick.provider as AgentProvider, value: pick.model } });
        if (pick.account !== undefined) {
            fix.selection.apply({ kind: `set`, picks: { account: pick.account } });
        }
        if (pick.harness !== undefined) {
            fix.selection.apply({ kind: `set`, picks: { harness: pick.harness as AgentHarness } });
        }
        if (pick.effort !== undefined) {
            fix.selection.apply({ kind: `setEffort`, effort: pick.effort });
        }
        if (pick.thinking !== undefined) {
            fix.selection.apply({ kind: `setThinking`, thinking: pick.thinking });
        }
        if (pick.fast !== undefined) {
            fix.selection.apply({ kind: `setFast`, fast: pick.fast });
        }
    };

    // The plan for a press, against the fleet as it stands now. The archive counts toward the next attempt's number
    // (conversation-ids.ts, nextFixAttemptId); read fresh, since it is the one half of the fleet the stream never pushes.
    const planPress = async (base: string, resume: FixResume | undefined): Promise<FixAttemptPlan> => {
        await loadArchived();
        return planFixAttempt(
            base,
            registry.value,
            [...registry.value, ...archived.value].map((agent) => agent.id),
            resume,
        );
    };

    // A start-over's preamble: the attempt it replaces is stopped if still running, then filed away. The archive
    // refuses a running conversation, so the order is not optional.
    const retireBefore = async (plan: FixAttemptPlan): Promise<void> => {
        if (plan.kind !== `start-over`) {
            return;
        }
        if (plan.stopFirst) {
            await stopAgent(plan.retire);
        }
        await archive([plan.retire]);
    };

    /* The agent is chosen from the current fleet, not the stale verdict. */
    const startFix = async (pick?: AgentRunChoice, resume?: FixResume): Promise<void> => {
        const fix = proposedFix.value;
        if (fix === undefined || fixBusy.value) {
            return;
        }
        fixBusy.value = true;
        fixError.value = undefined;
        // A press whose plan is still being read when the sandbox switches opens nothing: its failure was the old tree's.
        const current = sandboxScopeGuard();
        try {
            const plan = await planPress(fix.base, resume);
            if (!current()) {
                return;
            }
            if (plan.kind === `busy`) {
                openAttempt();
                return;
            }
            await retireBefore(plan);
            if (!current()) {
                return;
            }
            const conversation = composeSession({
                // Only an attempt that ran is nudged; one the door turned away (`resend`) never saw the task at all.
                prompt: plan.kind === `continue` ? fix.nudge : fix.prompt,
                ...fixWith.value,
                // Isolated, like any fleet agent: the fix belongs in its own worktree, arriving as a diff to review.
                isolated: true,
                conversationId: plan.conversationId,
            });
            if (pick !== undefined) {
                applyPick(conversation, pick);
            }
            dismiss();
            startSession(conversation);
        } catch (error) {
            fixError.value = errorMessage(error, `the attempt before it could not be set aside`);
        } finally {
            fixBusy.value = false;
        }
    };

    // Stops the suite, keeps the push: it settles as `cancelled`, so the wording matches any other outcome's, and
    // the question raised is the same: still waiting on you.
    const stopChecks = (): void => void usePrepush().cancel();

    return {
        pending: computed(() => pending.value),
        stage: computed(() => stage.value),
        since: computed(() => since.value),
        question: computed(() => question.value),
        /* The verdict is hidden while the card itself explains it. */
        held: computed(() => (question.value === undefined && stage.value === undefined ? standing.value : undefined)),
        // Whether the tree has been written to since the verdict settled: the difference between a red check that is
        // still the answer and one that is now history.
        heldStale: computed(() => (standing.value === undefined ? false : workspaceChangedSince(standing.value.at))),
        // Whether the card on screen is being reprinted rather than reporting a run that just ended.
        fromMemory: computed(() => fromMemory.value),
        // When the standing verdict settled, for a surface that dates it; the clock is the reader's, not this module's.
        verdictAt: computed(() => standing.value?.at),
        proposedFix: computed(() => proposedFix.value),
        // The proposed failure's live attempt and its stance, for the card's one slot; undefined means a fresh press.
        attempt: computed(attemptOf),
        attemptOnOffer: computed(attemptOnOffer),
        fixBusy: computed(() => fixBusy.value),
        fixError: computed(() => fixError.value),
        openAttempt,
        // The just-sent note; the only thing this flow ever says about a success.
        pushed: computed(() => pushed.value),
        // Whether anything is in flight; what the rail draws its spinner on.
        running: computed(() => stage.value !== undefined),
        // The command for the line that says what's happening: from the run while there is one, from settings before
        // the first poll answers.
        // The command the line names before the first poll answers: whichever stands first for the repositories this
        // press is sending, the owner's own ahead of a repository's, since that is the order they run in.
        command: computed(() => (usePrepush().run.value.command === `` ? firstCheckCommand() : usePrepush().run.value.command)),
        // The terminal of whichever run the moment is about; absent on a sandbox with no tmux wrapper, where a button
        // would only open an empty panel.
        terminal: computed(() => currentTerminal()?.session),
        typicalMs: computed(() => typicalMs.value),
        showTerminal: (): void => currentTerminal()?.show(),
        askSync,
        pushAnyway,
        // The standing verdict back on screen, whole; what the panel's own press does.
        reopen: (): void => reopen(),
        runAgain,
        startFix,
        stopChecks,
        dismiss,
    };
}
