import { type AgentHarness, type AgentProvider, type CommandRun, commandRunOutcome, type PushRun, quickModelKey } from "@intentic/sandbox-contract";
import type { AgentRunChoice } from "@intentic/ui";
import { computed, ref, shallowRef, watch } from "vue";
import { composeSession, startSession } from "../agents/sessionSuggestion";
import { useAgentRunModel } from "../chat/agentRunModel";
import type { Conversation } from "../chat/conversation";
import { useSandbox } from "../sandbox/useSandbox";
import { prepushCommandOf } from "../sandbox/rules";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { checkFixPrompt, checkOutcome, outcomeSummary, pushFixPrompt } from "./fixProposal";
import { type SyncTarget, useChanges } from "./useChanges";
import { usePrepush } from "./usePrepush";
import { resetPushRuns, usePushRun } from "./usePushRun";

/* THE PUSH, FROM THE CLICK TO THE ANSWER, the whole flow in one place, and deliberately not inside the panel
 * the click happens in.
 *
 * IT OUTLIVES ITS SURFACE, which is the entire point of moving it here. The check takes minutes; the user was
 * told to go and do something else, and doing something else means navigating, to the agents board, to a file,
 * to another repo's view. The flow used to live in the Changes panel's own setup, so leaving destroyed it: the
 * suite kept running, the push fired into an empty room when it went green, and a red verdict composed its fix
 * proposal into a component nobody was rendering. Module-level state has no such lifetime. Any surface that
 * wants to show the flow calls this and gets the same one.
 *
 * WHAT IT PROMISES, in the order the user meets it:
 *   1. The click is an INSTRUCTION, not an appointment. Asking to push commits to pushing; a green check sends
 *      it without asking again, whether or not anyone is watching.
 *   2. While it runs, the surface that was clicked says so IN PLACE (stage + since), and the rail says so from
 *      every other view. No dialog: there is nothing to decide yet, and the output belongs to the terminal.
 *   3. Only a RED outcome asks for the user back, `question`, which the app raises wherever they are, and
 *      which the daemon pushes to their devices when they have left the tab entirely (prepush/prepush.ts).
 *   4. Nothing is lost by walking away. The question and the fix proposal wait until they are answered.
 *
 * EVERY PUSH IN THE APP STILL COMES THROUGH ONE DOOR. `askSync` is that door now, useChanges deliberately
 * exports no single-repo push, because a second way to reach the verb is a way around the check. */

// What is about to leave, named the way the control that asked for it was labelled, so the flow answers the
// click the user made ("Publish", "Sync") instead of renaming it "Push" halfway through.
export interface PendingPush {
    readonly verb: string;
    // What is going out, "3 commits across 2 repos", "intentic's branch".
    readonly what: string;
    readonly targets: readonly SyncTarget[];
}

// Which half of the flow is in flight. Undefined the moment it settles: nothing is "running" while a question
// is waiting, and the two states drive different surfaces.
export type PushStage = "checking" | "pushing";

/* An outcome the user has to answer. Raised only for red, a pass is not a question, and phrasing it as one is
 * how the old dialog earned its "why am I being asked this" reputation. */
export interface PushQuestion {
    // Four words at most: it is read at a glance, from a view the user may have walked back into.
    readonly title: string;
    // The command, drawn in the monospace it wears while the run is still going, so the line reads the same
    // either side of the verdict: the check's command, or the push's own `git push …`. Absent only where
    // several repos refused at once, no one command can stand for them, and where a pull ahead of the push was
    // what failed, since nothing was run for it.
    readonly command?: string;
    // The predicate that follows it: what happened, in prose.
    readonly detail: string;
    /* `checks` still has a push to send, so the answer is Push anyway or hand it to an agent. `push` is the send
     * itself having been refused, there is nothing to override, so the same button is the retry, and where the
     * repository's own pre-push hook was what refused it, the fix is proposed exactly as for a red check. */
    readonly kind: "checks" | "push";
}

// How long the panel keeps saying "Pushed" after a green run. Long enough to be caught on the way back from
// wherever the user was, short enough that it is gone before it becomes furniture. A pass is not news that
// needs preserving: the outgoing work being gone is the durable half of the answer.
const PUSHED_NOTE_MS = 8_000;

const pending = shallowRef<PendingPush | undefined>(undefined);
const stage = ref<PushStage | undefined>(undefined);
// When the current stage began, what the elapsed readouts count from. Taken from the client rather than the
// run, because it has to cover the push half too, and the two halves must count in the same clock.
const since = ref(0);
const question = shallowRef<PushQuestion | undefined>(undefined);
// The fix session proposed for a failed check. shallowRef because a Conversation owns its own refs
// (agents/sessionSuggestion.ts), and composed ONCE so edits to its text and model survive every re-render and
// every navigation between the failure and the decision.
const proposedFix = shallowRef<Conversation | undefined>(undefined);
/* The push runs that settled red behind a `push` question (useChanges files them with their failures), held
 * for the two things the card reads off a run and not off its sentence: the terminal it ran in, and the tail
 * the proposed fix quotes. The check's run is the prepush watcher's own; these are per repo. */
const refusedRuns = shallowRef<readonly PushRun[]>([]);
const pushed = shallowRef<PendingPush | undefined>(undefined);
let pushedTimer: ReturnType<typeof setTimeout> | undefined;

/* The agent settings in force when the button was pressed, carried rather than re-read at settle time. The
 * proposal is composed minutes later and possibly from no mounted surface at all, and "what was configured when
 * you asked" is the honest answer anyway. */
let fixWith: { model?: string; effort?: string } = {};

/* The git actions and the sandbox's identity, captured on the first call from a mounted surface. ONLY the
 * module-level halves of useChanges are ever read through this, `syncAll`, `actionBusy` and `failures` are one
 * per app rather than one per caller, so the capture stays good after the surface that made it has gone, which
 * is precisely the situation this flow exists to survive. The query-backed halves (`repos`, `outgoing`) are the
 * panel's business and are not touched here. */
let git: ReturnType<typeof useChanges> | undefined;
let sandboxId: ReturnType<typeof useSandbox>["activeSandboxId"] | undefined;

const prepush = usePrepush();

/* HOW LONG THIS SUITE USUALLY TAKES, remembered across runs. Waiting is bearable when you know the size of it,
 * and leaving is comfortable when you know roughly when to come back, which is the difference between a
 * progress readout and a progress readout that lets someone stop watching.
 *
 * Per sandbox, because the command is: two workspaces have two suites. localStorage rather than the daemon,
 * mirroring the commit draft, it is a client-side convenience, and the daemon deliberately keeps nothing about
 * a check at rest (prepush/prepush.ts). */
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
        // Storage may be unavailable (private mode). The readout degrades to elapsed-only, which is the half
        // that matters most anyway.
    }
};

// Only a run that RAN to a verdict measures anything: a cancel and a timeout are the clock being cut short, and
// remembering either would teach the readout a duration no suite ever takes.
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

// Entering a stage supersedes whatever was being asked: a new push is a new question, and the fix proposed for
// the last one is about a verdict nobody is waiting on any more.
const enter = (push: PendingPush, next: PushStage): void => {
    pending.value = push;
    stage.value = next;
    since.value = Date.now();
    question.value = undefined;
    proposedFix.value = undefined;
    refusedRuns.value = [];
};

// Back to rest, having sent what was asked for. The note is the only thing left, and it expires by itself.
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

/* A batch of git actions the user started while the suite ran, a commit, a fetch, a discard, holds the
 * panel's one busy span, and useChanges refuses re-entry while it does. A push fired into that would be
 * silently dropped, and this flow would report "Pushed" over a push that never happened. So it waits for the
 * door instead of knocking on a closed one: the user was invited to keep working, and the push they asked for
 * has to survive them accepting the invitation. */
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

/* Send it. The failures useChanges files per repo ARE the outcome, the batch carries on past a repo that
 * refused, so "did this push go" is a question about which scopes came back marked, not about a thrown error.
 *
 * A push is a RUN (usePushRun.ts), and a refused one is filed with its run, so the question raised here is the
 * same question a red check raises, from the same material: the command in monospace, one line on how it
 * ended, the terminal it ran in, and, where the repository's own pre-push hook was what said no, the fix
 * composed from what the hook printed. A rejected ref or a dead host proposes nothing, on the rule `error` and
 * `cancelled` checks follow: nothing is known to be wrong with the code, and an agent sent after it would hunt
 * a bug that isn't there. */
const send = async (push: PendingPush): Promise<void> => {
    enter(push, `pushing`);
    prepush.forget();
    await untilIdle();
    // Another ask superseded this one while it waited. Whatever the flow is about now, it is not this.
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
        proposedFix.value = composeSession({ prompt: pushFixPrompt(byHook), ...fixWith, isolated: true });
    }
};

// The question a refused send raises, from the failures useChanges filed against the repos that refused.
const refusalQuestion = (push: PendingPush, refused: readonly string[]): PushQuestion => {
    const only = refused.length === 1 ? git!.failures.value.get(refused[0]!) : undefined;
    if (only === undefined) {
        // Several cannot share a line, and each row in the panel is already carrying its own reason under
        // the repo that produced it.
        return { kind: `push`, title: `${push.verb} failed`, detail: `${refused.length} repos refused it, each row says why.` };
    }
    if (only.run === undefined) {
        // No run: a pull that failed ahead of the push. The line has to name the repo itself.
        return { kind: `push`, title: `${push.verb} failed`, detail: `${refused[0]}: ${only.detail}` };
    }
    // The run's own outcome names it ("Push timed out"), its command is drawn above the line, and the line is
    // the predicate that follows the command, exactly as a red check's is.
    return { kind: `push`, title: commandRunOutcome(only.run, push.verb), command: only.run.command, detail: only.detail };
};

/* The terminal the current moment is about: the check's while the check runs or after it said no, the push's
 * while it runs (whichever target's is in a terminal already) or after it was refused. One button on every
 * surface, pointed at whichever run the user is being asked about. */
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

/* EVERYTHING THIS FLOW IS HOLDING ABOUT ONE WORKSPACE'S OUTGOING WORK, dropped when the browser is pointed at
 * another one. Called from sandboxScope.
 *
 * All of it names repositories, commits and a check suite in a single /work: a staged push, the stage it
 * reached, the question waiting on an answer, the fix session composed for a failure. Carried across a switch,
 * the panel offers to send the previous sandbox's commits, and answering the question would run a check in a
 * workspace the reader is no longer in.
 *
 * `git` and `sandboxId` are deliberately NOT dropped. They are captures of module-level composables, one per
 * app, not one per sandbox, and re-capturing them needs a mounted surface, which a switch does not guarantee
 * there is one of. `typicalMs` is not dropped either: its own watch on the sandbox id already re-reads it. */
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
    fixWith = {};
    // The runs being followed name repositories in the same workspace, and are dropped with the flow that
    // started them rather than by a second caller that would have to remember to.
    resetPushRuns();
};

export function usePushFlow() {
    git ??= useChanges();
    const { settings } = useSandboxSettings();
    const agentRun = useAgentRunModel();
    if (sandboxId === undefined) {
        sandboxId = useSandbox().activeSandboxId;
        watch(sandboxId, (id) => readTypical(id), { immediate: true });
    }

    /* THE ONE DOOR. Every Push, Sync and Publish in the app arrives here, the sync bar's button and each repo
     * row's pill alike, so the check cannot be walked around by taking a different route to the same verb.
     *
     * A pull-only sync passes straight through: nothing leaves the machine, so there is nothing to check. So
     * does a workspace with no check configured, and both still report their outcome, because "did my push
     * go" is a question the user asks whether or not a suite was involved. */
    const askSync = (verb: string, what: string, targets: readonly SyncTarget[]): void => {
        if (stage.value !== undefined) {
            return;
        }
        const push: PendingPush = { verb, what, targets };
        // The HEAD of the agent-run list, the entry the daemon would reach for, rather than the raw setting:
        // this is composed into a draft the user can see and re-point, so it has to name a model that can
        // actually be sent. `quickModelKey` because composeSession takes the pinned `${provider}:${model}` form.
        // Read before the check is even considered: a push with no check configured can still be refused by
        // the repository's own hook, and the fix proposed for that reads the same settings.
        const head = agentRun.choice.value;
        fixWith = { ...(head === undefined ? {} : { model: quickModelKey(head) }), effort: settings.value?.agentRunEffort };
        const command = prepushCommandOf(settings.value?.rules ?? []);
        if (command === `` || !targets.some((target) => target.push)) {
            void send(push);
            return;
        }
        enter(push, `checking`);
        void prepush.start().then((settled) => {
            rememberTypical(settled);
            /* Still ours, and still the half of the flow that was waiting on it. Either guard failing means the
             * user has already answered, pushed anyway, dismissed, or started another sync, and a verdict
             * arriving after the decision has nobody to interrupt. */
            if (pending.value !== push || stage.value !== `checking`) {
                return;
            }
            if (settled.status === `passed`) {
                void send(push);
                return;
            }
            stage.value = undefined;
            question.value = { kind: `checks`, title: checkOutcome(settled), command: settled.command, detail: outcomeSummary(settled) };
            /* `error` and `cancelled` get no fix proposal. The command could not run, or the user stopped it,
             * either way nothing is known to be wrong with the code, and an agent sent after it would hunt a bug
             * that isn't there. */
            if (settled.status === `failed`) {
                proposedFix.value = composeSession({
                    prompt: checkFixPrompt(settled),
                    ...fixWith,
                    // Isolated, like any other fleet agent: the work under test is committed on a branch, so the
                    // fix belongs in a worktree of its own and arrives as a diff to review rather than as edits
                    // landing underneath the push the user is still deciding about.
                    isolated: true,
                });
            }
        });
    };

    /* Push anyway, the answer that is always available, during the run and after a failure, and which never
     * asks a second time. The user knows things the check does not: that the failure is the one they are pushing
     * a fix for, that the suite is flaky, that they need this on a branch to look at it in CI. A check that
     * BLOCKED the push would be switched off within the week.
     *
     * A check still running is left running, in the terminal it is running in: killing it here would decide, on
     * the user's behalf, that an answer they chose not to wait for is an answer nobody wants. */
    const pushAnyway = (): void => {
        const push = pending.value;
        if (push !== undefined) {
            void send(push);
        }
    };

    // Let it go unanswered, the push does not happen, and nothing is left running that was not already. The
    // suite is not killed for the same reason Push anyway does not kill it.
    const dismiss = (): void => {
        pending.value = undefined;
        stage.value = undefined;
        question.value = undefined;
        proposedFix.value = undefined;
        refusedRuns.value = [];
        prepush.forget();
    };

    // Hand the failure to an agent. The push does NOT go: the point of accepting the fix is that this tree is
    // not the one to push, and the agent's diff comes back for review like any other.
    const startFix = (pick?: AgentRunChoice): void => {
        const fix = proposedFix.value;
        dismiss();
        if (fix !== undefined) {
            if (pick !== undefined && `selectModel` in fix) {
                fix.selectModel({ provider: pick.provider as AgentProvider, value: pick.model });
                if (pick.account !== undefined) {
                    fix.account.value = pick.account;
                }
                if (pick.harness !== undefined) {
                    fix.harness.value = pick.harness as AgentHarness;
                }
            }
            startSession(fix);
        }
    };

    // Stop the suite, keep the push. The run settles as `cancelled`, so the wording still comes from where every
    // other outcome's does, and the question it raises is the same one: this push is still waiting on you.
    const stopChecks = (): void => void prepush.cancel();

    return {
        pending: computed(() => pending.value),
        stage: computed(() => stage.value),
        since: computed(() => since.value),
        question: computed(() => question.value),
        proposedFix: computed(() => proposedFix.value),
        // The just-sent note, and the only thing this flow ever says about a success.
        pushed: computed(() => pushed.value),
        // Whether anything at all is in flight, what the rail draws its spinner on.
        running: computed(() => stage.value !== undefined),
        // The command being run, for the line that says what is happening. From the run while there is one, from
        // settings in the moment before the first poll answers.
        command: computed(() => (prepush.run.value.command === `` ? prepushCommandOf(settings.value?.rules ?? []) : prepush.run.value.command)),
        // The terminal of whichever run the moment is about (currentTerminal), where it exists: absent on a
        // sandbox with no tmux wrapper, where the command ran in an invisible shell and a button would only
        // open an empty panel.
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
