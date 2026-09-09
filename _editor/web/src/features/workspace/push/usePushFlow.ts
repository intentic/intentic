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
import { workspaceChangedSince } from "../changes/useWorkspaceLive";
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

/* THE RED VERDICT THAT OUTLIVES ITS CARD. Closing the card answers nothing: the tree still fails and the push still
 * has not gone, so the fact is filed here for the panel to state and for a press to re-raise. Everything the card
 * needs rides along, since all of it is recoverable material rather than a live run: the question's own words, the
 * proposal (derived from the failure, not from the press), and the runs behind a refused send. */
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

const proposedFix = shallowRef<FixProposal | undefined>(undefined);
const standing = shallowRef<StandingVerdict | undefined>(undefined);
// Whether the card on screen is a verdict being reprinted rather than one that just landed; the card says so, since
// "Checks failed" reads as news and this is not news.
const fromMemory = ref(false);
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

/* THE ONE DOOR EVERY RED OUTCOME COMES THROUGH: it raises the question and files the same material as the verdict
 * that stays behind once the card is closed. Two callers, the check's verdict and a refused send, so neither can
 * put something on screen the panel then cannot say. */
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

/* WHEN A STANDING VERDICT IS STILL THE ANSWER, and a press need not spend the suite again: a check that FAILED (the
 * only outcome that measured anything) on a tree nothing has been written to since. A refused send is never reused —
 * the code is not what refused it, and pressing again means try the remote again. */
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
        return { kind: `push`, title: `${push.verb} failed`, detail: `${refused.length} repos refused it, each row says why.` };
    }
    if (only.run === undefined) {
        // No run: a pull that failed ahead of the push, so the line names the repo itself.
        return { kind: `push`, title: `${push.verb} failed`, detail: `${refused[0]}: ${only.detail}` };
    }
    // The run's own outcome names it; its command sits above the line, the predicate that follows, as a check's is.
    return { kind: `push`, title: commandRunOutcome(only.run, push.verb), command: only.run.command, detail: only.detail };
};

/* WHICH PUSH RUNS THE MOMENT IS ABOUT: the ones a send in flight is writing, or the ones a refusal filed. Only a
 * refused send ever fills either list, so no check on the question's kind is needed to tell them apart. The standing
 * verdict's copy answers once the card is closed: the window the failure ran in is still open, and it is the one
 * thing about a failure the card never held itself. */
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
    standing.value = undefined;
    fromMemory.value = false;
    pushed.value = undefined;
    fixBusy.value = false;
    fixError.value = undefined;
    fixWith = {};
    // Runs being followed are dropped with the flow that started them, not left for a second caller to remember.
    // The check's own goes too, now that a settled one survives its card: its terminal is a window in the /work
    // the reader has left, and a button pointing there would open somebody else's.
    prepush.forget();
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
        /* A RED VERDICT NOTHING HAS BEEN WRITTEN OVER IS STILL THE ANSWER, so this press reprints it instead of
         * spending the suite to reach the same verdict on the same bytes. Minutes are the cost of finding something
         * out; spending them to be told what is already known is what makes a check feel like a toll. The card says
         * it is from memory and offers to run it again for the reader who wants the suite regardless. */
        if (reusable() !== undefined) {
            reopen(push);
            return;
        }
        runChecks(push);
    };

    /* THE CHECK, AND THE ONLY PLACE IT STARTS: a press with nothing standing, and the reader who rejects what does
     * stand (Run again). A verdict landing on a superseded push is dropped rather than shown — the user answered
     * already, and there is nobody left to interrupt. */
    function runChecks(push: PendingPush): void {
        enter(push, `checking`);
        void prepush.start().then((settled) => {
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

    /* CLOSING THE CARD, WHICH ANSWERS NOTHING. The push doesn't happen and nothing new is left running; the suite
     * isn't killed, for the same reason Push anyway doesn't kill it. What is NOT dropped is the verdict itself
     * (`standing`): the tree still fails and the push is still owed, so the panel keeps saying so and a press brings
     * the card back. The run is left with the watcher too, since forgetting it would take the terminal button's
     * session with it — and that terminal is where the whole of the output is. */
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
        /* THE VERDICT AS EVERY SURFACE BUT THE CARD SEES IT: absent while the card is up (it is saying all of this
         * itself) and while anything is in flight (that is the news). What is left is the standing fact for the panel
         * to state and the rail to mark, so neither has to work out when it is the card's turn to speak. */
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
        command: computed(() => (prepush.run.value.command === `` ? prepushCommandOf(settings.value?.rules ?? []) : prepush.run.value.command)),
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
