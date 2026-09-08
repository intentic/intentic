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
} from "@intentic/sandbox-contract";
import type { AgentRunAttempt, AgentRunChoice } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, shallowRef, watch } from "vue";
import { stopAgent } from "../../agents/fleet/agentActions";
import { composeSession, startSession } from "../../agents/fleet/sessionSuggestion";
import { open as openAgent } from "../../agents/fleet/useAgents-actions";
import { archive } from "../../agents/fleet/useAgents-archive";
import { archived, loadArchived, registry } from "../../agents/fleet/useAgents-registry";
import { modelLabelFor } from "../../chat/accounts/providerCatalog";
import { useRoleModel } from "../../chat/accounts/roleModel";
import type { Conversation } from "../../chat/session/conversation";
import { useSandbox } from "../../sandbox/client/useSandbox";
import { prepushCommandOf } from "../../sandbox/environment/rules";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { checkFixPrompt, checkNudgePrompt, checkOutcome, fixSignature, outcomeSummary, pushFixPrompt, pushNudgePrompt } from "../health/fixProposal";
import { type SyncTarget, useChanges } from "../changes/useChanges";
import { usePrepush } from "./usePrepush";
import { resetPushRuns, usePushRun } from "./usePushRun";

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

const pending = shallowRef<PendingPush | undefined>(undefined);
const stage = ref<PushStage | undefined>(undefined);
// When the stage began; taken from the client, not the run, so check and push halves share one clock.
const since = ref(0);
const question = shallowRef<PushQuestion | undefined>(undefined);
/* THE FIX A RED VERDICT PROPOSES: the failure it answers (its derived id, which attempt 1 wears), the opening prompt
 * a fresh attempt gets, and the shorter nudge a continued one gets. Not a composed Conversation, as it used to be:
 * WHICH conversation the press opens is decided at the press (planFixAttempt), from the fleet as it stands then,
 * since between the verdict and the press an attempt may have ended, landed, or been set aside. Composing at the
 * verdict also meant a proposal for an already-open conversation overwrote the draft sitting in its composer. */
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

const proposedFix = shallowRef<FixProposal | undefined>(undefined);
// A press in flight: stopping and filing away the attempt before it, then opening the next. The button waits on it.
const fixBusy = ref(false);
// Why the last press could not start anything, in the daemon's words; cleared by the next press.
const fixError = ref<string | undefined>(undefined);
// Push runs that settled red behind a `push` question: the terminal each ran in and the tail the fix quotes.
const refusedRuns = shallowRef<readonly PushRun[]>([]);
const pushed = shallowRef<PendingPush | undefined>(undefined);
let pushedTimer: ReturnType<typeof setTimeout> | undefined;

// Agent settings when the button was pressed, carried since the proposal may compose minutes later, unmounted.
let fixWith: { model?: string; effort?: string } = {};

// Git actions and sandbox id, captured once from a mounted surface. Only useChanges's module-level halves
// (syncAll, actionBusy, failures) are read here; the query-backed halves are the panel's own.
let git: ReturnType<typeof useChanges> | undefined;
let sandboxId: ReturnType<typeof useSandbox>["activeSandboxId"] | undefined;

const prepush = usePrepush();

// How long this suite usually takes, remembered per sandbox in localStorage, not the daemon, which keeps
// nothing about a check at rest.
const storageKey = (id: string): string => `intentic.prepushDuration.${id}`;
const typicalMs = ref<number | undefined>(undefined);

const readTypical = (id: string | undefined): void => {
    typicalMs.value = undefined;
    if (id === undefined) {
        return;
    }
    try {
        const stored = Number(localStorage.getItem(storageKey(id)));
        typicalMs.value = Number.isFinite(stored) && stored > 0 ? stored : undefined;
    } catch {
        // Storage may be unavailable (private mode); the readout degrades to elapsed-only.
    }
};

// Only a run that reached a verdict measures anything; a cancel or timeout is the clock cut short, and
// remembering it would teach the readout a duration no suite takes.
const rememberTypical = (run: CommandRun): void => {
    const { startedAt, finishedAt } = run;
    if (startedAt === undefined || finishedAt === undefined || (run.status !== `passed` && run.status !== `failed`) || run.timedOut === true) {
        return;
    }
    typicalMs.value = finishedAt - startedAt;
    const id = sandboxId?.value;
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
// is about a verdict nobody's waiting on.
const enter = (push: PendingPush, next: PushStage): void => {
    pending.value = push;
    stage.value = next;
    since.value = Date.now();
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
    fixError.value = undefined;
};

// Back to rest, having sent what was asked; the note is the only thing left, and it expires on its own.
const done = (push: PendingPush): void => {
    pending.value = undefined;
    stage.value = undefined;
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
    prepush.forget();
    pushed.value = push;
    clearTimeout(pushedTimer);
    pushedTimer = setTimeout(() => (pushed.value = undefined), PUSHED_NOTE_MS);
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
    prepush.forget();
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
    refusedRuns.value = runs;
    question.value = refusalQuestion(push, refused);
    const byHook = runs.filter((run) => run.refusedBy === `hook`);
    if (byHook.length > 0) {
        proposedFix.value = {
            // One hook failure across several repos is one fix in one worktree, so it's one conversation.
            base: pushFixConversationId(byHook.map((run) => run.repo).join(`-`), fixSignature(byHook.map((run) => run.output).join(`\n`))),
            prompt: pushFixPrompt(byHook),
            nudge: pushNudgePrompt(byHook),
        };
    }
};

// The question a refused send raises, from the failures useChanges filed against the repos that refused.
const refusalQuestion = (push: PendingPush, refused: readonly string[]): PushQuestion => {
    const only = refused.length === 1 ? git!.failures.value.get(refused[0]!) : undefined;
    if (only === undefined) {
        // Several can't share a line; each row in the panel already carries its own reason.
        return { kind: `push`, title: `${push.verb} failed`, detail: `${refused.length} repos refused it, each row says why.` };
    }
    if (only.run === undefined) {
        // No run: a pull that failed ahead of the push, so the line names the repo itself.
        return { kind: `push`, title: `${push.verb} failed`, detail: `${refused[0]}: ${only.detail}` };
    }
    // The run's own outcome names it; its command sits above the line, the predicate that follows, as a check's is.
    return { kind: `push`, title: commandRunOutcome(only.run, push.verb), command: only.run.command, detail: only.detail };
};

// The terminal the current moment is about: the check's while it runs or after refusing, the push's while
// running or after refusal. One button on every surface, pointed at whichever run is in question.
const currentTerminal = (): { readonly session: string; readonly show: () => void } | undefined => {
    const pushRuns =
        question.value?.kind === `push`
            ? refusedRuns.value.map((run) => usePushRun(run.repo))
            : stage.value === `pushing`
              ? (pending.value?.targets ?? []).filter((target) => target.push).map((target) => usePushRun(target.repo))
              : [];
    const watcher = pushRuns.find((candidate) => candidate.terminal.value !== undefined);
    if (watcher !== undefined) {
        return { session: watcher.terminal.value!, show: watcher.showTerminal };
    }
    const session = prepush.terminal.value;
    return session === undefined ? undefined : { session, show: prepush.showTerminal };
};

// Drops what this flow holds about one workspace's outgoing work on a sandbox switch: a staged push is about
// a /work the reader has left. `git`/`sandboxId`/`typicalMs` stay: module-level captures, re-read by their own watches.
export const resetPushFlow = (): void => {
    clearTimeout(pushedTimer);
    pushedTimer = undefined;
    pending.value = undefined;
    stage.value = undefined;
    since.value = 0;
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
    pushed.value = undefined;
    fixBusy.value = false;
    fixError.value = undefined;
    fixWith = {};
    // Runs being followed are dropped with the flow that started them, not left for a second caller to remember.
    resetPushRuns();
};

export function usePushFlow() {
    git ??= useChanges();
    const { settings } = useSandboxSettings();
    // This job's own model list: a pre-push fix reads a failing check on work about to leave the machine.
    const prePushFix = useRoleModel(`pre-push-fix`);
    if (sandboxId === undefined) {
        sandboxId = useSandbox().activeSandboxId;
        watch(sandboxId, (id) => readTypical(id), { immediate: true });
    }

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
        fixWith = head === undefined ? {} : { model: modelPinKey(head), effort: head.effort };
        const command = prepushCommandOf(settings.value?.rules ?? []);
        if (command === `` || !targets.some((target) => target.push)) {
            void send(push);
            return;
        }
        enter(push, `checking`);
        void prepush.start().then((settled) => {
            rememberTypical(settled);
            // Still ours: either guard failing means the user already answered; a late verdict has nobody to interrupt.
            if (pending.value !== push || stage.value !== `checking`) {
                return;
            }
            if (settled.status === `passed`) {
                void send(push);
                return;
            }
            stage.value = undefined;
            question.value = { kind: `checks`, title: checkOutcome(settled), command: settled.command, detail: outcomeSummary(settled) };
            // `error` and `cancelled` propose no fix: either way nothing is known to be wrong with the code.
            if (settled.status === `failed`) {
                proposedFix.value = {
                    // Named after what failed, not this press: the check reruns each attempt, so a name minted per
                    // press would hide from the card that an agent is already on this failure.
                    base: pushFixConversationId(scopeOf(push), fixSignature(settled.output)),
                    prompt: checkFixPrompt(settled),
                    nudge: checkNudgePrompt(settled),
                };
            }
        });
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

    // Leaves it unanswered: the push doesn't happen, and nothing new is left running. The suite isn't killed, for
    // the same reason Push anyway doesn't kill it.
    const dismiss = (): void => {
        pending.value = undefined;
        stage.value = undefined;
        question.value = undefined;
        proposedFix.value = undefined;
        refusedRuns.value = [];
        fixError.value = undefined;
        prepush.forget();
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

    /* WHAT THE CARET CHOSE, ONTO THE DRAFT. Each field is applied only when the pick NAMED it: the draft was
     * already composed on the pinned entry (`fixWith`), so an untouched knob leaves that standing rather than
     * resetting a proposal the reader can still see. `setEffort` writes the PICK, which the draft then clamps to
     * whatever the model just chosen actually offers.
     *
     * All five travel, because all five are things the picker sets and each is a different run: a fix re-pointed
     * at a frontier model but not at the tier, the loop, the account or the speed it was configured under is not
     * the fix the reader pressed for. */
    const applyPick = (fix: Conversation, pick: AgentRunChoice): void => {
        fix.selectModel({ provider: pick.provider as AgentProvider, value: pick.model });
        if (pick.account !== undefined) {
            fix.account.value = pick.account;
        }
        if (pick.harness !== undefined) {
            fix.harness.value = pick.harness as AgentHarness;
        }
        if (pick.effort !== undefined) {
            fix.setEffort(pick.effort);
        }
        if (pick.thinking !== undefined) {
            fix.setThinking(pick.thinking);
        }
        if (pick.fast !== undefined) {
            fix.setFast(pick.fast);
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

    /* HAND THE FAILURE TO AN AGENT, decided against the fleet as it stands NOW rather than at the verdict
     * (planFixAttempt): a first attempt opens under the failure's own id; an ended one is continued with the nudge;
     * a start-over files the latest away and opens the next on a clean worktree; and an attempt still in play is
     * opened rather than raced. The push does NOT go in any of these: the point of accepting the fix is that this
     * tree is not the one to push, and the agent's diff comes back for review like any other. `resume` is the verb
     * the picker's bar was ended with; absent is the plain press. */
    const startFix = async (pick?: AgentRunChoice, resume?: FixResume): Promise<void> => {
        const fix = proposedFix.value;
        if (fix === undefined || fixBusy.value) {
            return;
        }
        fixBusy.value = true;
        fixError.value = undefined;
        try {
            const plan = await planPress(fix.base, resume);
            if (plan.kind === `busy`) {
                openAttempt();
                return;
            }
            await retireBefore(plan);
            const conversation = composeSession({
                prompt: plan.kind === `continue` ? fix.nudge : fix.prompt,
                ...fixWith,
                // Isolated, like any fleet agent: the fix belongs in its own worktree, arriving as a diff to review.
                isolated: true,
                conversationId: plan.conversationId,
            });
            if (pick !== undefined && `selectModel` in conversation) {
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
    const stopChecks = (): void => void prepush.cancel();

    return {
        pending: computed(() => pending.value),
        stage: computed(() => stage.value),
        since: computed(() => since.value),
        question: computed(() => question.value),
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
        command: computed(() => (prepush.run.value.command === `` ? prepushCommandOf(settings.value?.rules ?? []) : prepush.run.value.command)),
        // The terminal of whichever run the moment is about; absent on a sandbox with no tmux wrapper, where a button
        // would only open an empty panel.
        terminal: computed(() => currentTerminal()?.session),
        typicalMs: computed(() => typicalMs.value),
        showTerminal: (): void => currentTerminal()?.show(),
        askSync,
        pushAnyway,
        startFix,
        stopChecks,
        dismiss,
    };
}
