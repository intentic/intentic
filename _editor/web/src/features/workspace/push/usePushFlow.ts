import {
    type AgentHarness,
    type AgentProvider,
    type AgentSummary,
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
import { fixSignature, pushFixPrompt, pushNudgePrompt } from "../health/fixProposal";
import { type SyncTarget, useChanges } from "../changes/useChanges";
import { workspaceChangedSince } from "../changes/live/useWorkspaceLive";
import { usePushRun } from "./usePushRun";
import { t } from "@intentic/ui/i18n";

// The push flow, from click to answer, kept at module level (not in the panel) so it outlives the surface
// that started it: any view calling this gets the same instance. `askSync` is the one door every push goes
// through; useChanges exports no single-repo push, so no refusal goes unasked.
//
// - a click is an instruction: it sends at once, whether anyone's watching or not; the gate is each repository's own
//   git pre-push hook, which the push runs.
// - while running, the surface says so in place, and the rail says so from anywhere else; no dialog, since
//   there's nothing to decide yet.
// - only a refusal raises `question`, wherever the user is.
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

// A refusal the user must answer; a pass is never phrased as a question.
export interface PushQuestion {
    // Four words at most, read at a glance from a view the user may have walked back into.
    readonly title: string;
    // The command, in the monospace it wears mid-run; absent when several repos refused at once or nothing ran.
    readonly command?: string;
    // The predicate that follows it: what happened, in prose.
    readonly detail: string;
}

// How long the panel says "Pushed": long enough to catch on the way back, short enough not to linger.
const PUSHED_NOTE_MS = 8_000;

// Everything below names commits and runs in one sandbox's /work; offering to send them from another is the most
// consequential thing a switch could carry over, so all of it is sandbox-scoped.
const pending = sandboxShallowRef<PendingPush | undefined>(() => undefined);
const sending = sandboxRef(() => false);
// When the push began, on the client's clock.
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
    // When it settled. What the panel counts from, and what a write to the tree is compared against.
    readonly at: number;
}

const proposedFix = sandboxShallowRef<FixProposal | undefined>(() => undefined);
const standing = sandboxShallowRef<StandingVerdict | undefined>(() => undefined);
// Whether the card on screen is a verdict being reprinted rather than one that just landed; the card says so, since
// "Push failed" reads as news and this is not news.
const fromMemory = sandboxRef(() => false);
// A press in flight: stopping and filing away the attempt before it, then opening the next. The button waits on it.
const fixBusy = sandboxRef(() => false);
// Why the last press could not start anything, in the daemon's words; cleared by the next press.
const fixError = sandboxRef<string | undefined>(() => undefined);
// Push runs that settled red behind the question: the terminal each ran in and the tail the fix quotes.
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

// A new push supersedes whatever was being asked, standing verdict included: the hook is about to answer again.
const enter = (push: PendingPush): void => {
    pending.value = push;
    sending.value = true;
    since.value = Date.now();
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
    fixError.value = undefined;
    standing.value = undefined;
    fromMemory.value = false;
};

/* Every refusal raises the same question and records the same verdict material. */
const raise = (push: PendingPush, asked: PushQuestion, filed: Pick<StandingVerdict, "fix" | "runs" | "at">): void => {
    question.value = asked;
    proposedFix.value = filed.fix;
    refusedRuns.value = filed.runs;
    standing.value = { push, question: asked, ...filed };
    fromMemory.value = false;
};

// Back on screen, unchanged, at no cost: the same words, the same proposal, the same retry.
const reopen = (): void => {
    const held = standing.value;
    if (held === undefined) {
        return;
    }
    pending.value = held.push;
    question.value = held.question;
    proposedFix.value = held.fix;
    refusedRuns.value = held.runs;
    fixError.value = undefined;
    fromMemory.value = true;
};

// Back to rest, having sent what was asked; the note is the only thing left, and it expires on its own.
const done = (push: PendingPush): void => {
    pending.value = undefined;
    sending.value = false;
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
    // The work left the machine, so nothing about it is still owed; a verdict from before it would be a warning
    // about a push that has already gone.
    standing.value = undefined;
    fromMemory.value = false;
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

// Failures useChanges files per repo are the outcome; the batch carries on past a refusal. Only a hook's refusal is
// known to be about the code, so only it proposes a fix.
const send = async (push: PendingPush): Promise<void> => {
    enter(push);
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
    sending.value = false;
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
            title: t(`workspace.usePushFlow.failed`, { verb: push.verb }),
            detail: t(`workspace.usePushFlow.reposRefusedEachRow`, { count: refused.length }),
        };
    }
    if (only.run === undefined) {
        // No run: a pull that failed ahead of the push, so the line names the repo itself.
        return { title: t(`workspace.usePushFlow.failed`, { verb: push.verb }), detail: `${refused[0]}: ${only.detail}` };
    }
    // The run's own outcome names it; its command sits above the line, the predicate that follows.
    return { title: commandRunOutcome(only.run, push.verb), command: only.run.command, detail: only.detail };
};

/* WHICH PUSH RUNS THE MOMENT IS ABOUT: the ones a send in flight is writing, or the ones a refusal filed. Only. */
const runsInQuestion = (): readonly ReturnType<typeof usePushRun>[] => {
    if (sending.value) {
        return (pending.value?.targets ?? []).filter((target) => target.push).map((target) => usePushRun(target.repo));
    }
    const refused = refusedRuns.value.length > 0 ? refusedRuns.value : (standing.value?.runs ?? []);
    return refused.map((run) => usePushRun(run.repo));
};

// The terminal of the push in question, while it runs and for as long as its refusal stands.
const currentTerminal = (): { readonly session: string; readonly show: () => void } | undefined => {
    const watcher = runsInQuestion().find((candidate) => candidate.terminal.value !== undefined);
    return watcher === undefined ? undefined : { session: watcher.terminal.value!, show: watcher.showTerminal };
};

export function usePushFlow() {
    git ??= useChanges();
    // This job's own model list: a pre-push fix reads what a repository's hook refused on work about to leave.
    const prePushFix = useRoleModel(`pre-push-fix`);

    // The one door every Push, Sync and Publish arrives at, so every refusal is asked about the same way.
    const askSync = (verb: string, what: string, targets: readonly SyncTarget[]): void => {
        if (sending.value) {
            return;
        }
        const head = prePushFix.choice.value;
        fixWith.value = head === undefined ? {} : { model: modelPinKey(head), effort: head.effort };
        void send({ verb, what, targets });
    };

    // The same push again, hook and all.
    const retry = (): void => {
        const push = pending.value;
        if (push !== undefined && !sending.value) {
            void send(push);
        }
    };

    /* Closing the card leaves the standing verdict and its run available. */
    const dismiss = (): void => {
        pending.value = undefined;
        sending.value = false;
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
            await stopAgent(plan.retire, undefined, { live: true });
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

    return {
        pending: computed(() => pending.value),
        since: computed(() => since.value),
        question: computed(() => question.value),
        /* The verdict is hidden while the card itself explains it. */
        held: computed(() => (question.value === undefined && !sending.value ? standing.value : undefined)),
        // Whether the tree has been written to since the verdict settled, so the hook may no longer say the same.
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
        // Whether a push is in flight; what the rail draws its spinner on.
        running: computed(() => sending.value),
        // The terminal of whichever run the moment is about; absent on a sandbox with no tmux wrapper, where a button
        // would only open an empty panel.
        terminal: computed(() => currentTerminal()?.session),
        showTerminal: (): void => currentTerminal()?.show(),
        askSync,
        retry,
        // The standing verdict back on screen, whole; what the panel's own press does.
        reopen,
        startFix,
        dismiss,
    };
}
