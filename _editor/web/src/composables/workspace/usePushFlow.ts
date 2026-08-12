import { type PrepushRun, quickModelKey } from "@intentic/sandbox-contract";
import { computed, ref, shallowRef, watch } from "vue";
import { composeSession, startSession } from "../agents/sessionSuggestion";
import { useAgentRunModel } from "../chat/agentRunModel";
import type { Conversation } from "../chat/conversation";
import { useSandbox } from "../sandbox/useSandbox";
import { prepushCommandOf } from "../sandbox/rules";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { checkOutcome, fixPrompt, fixSummary } from "./prepushFix";
import { type SyncTarget, useChanges } from "./useChanges";
import { usePrepush } from "./usePrepush";

/* THE PUSH, FROM THE CLICK TO THE ANSWER — the whole flow in one place, and deliberately not inside the panel
 * the click happens in.
 *
 * IT OUTLIVES ITS SURFACE, which is the entire point of moving it here. The check takes minutes; the user was
 * told to go and do something else, and doing something else means navigating — to the agents board, to a file,
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
 *   3. Only a RED outcome asks for the user back — `question`, which the app raises wherever they are, and
 *      which the daemon pushes to their devices when they have left the tab entirely (prepush/prepush.ts).
 *   4. Nothing is lost by walking away. The question and the fix proposal wait until they are answered.
 *
 * EVERY PUSH IN THE APP STILL COMES THROUGH ONE DOOR. `askSync` is that door now — useChanges deliberately
 * exports no single-repo push, because a second way to reach the verb is a way around the check. */

// What is about to leave, named the way the control that asked for it was labelled — so the flow answers the
// click the user made ("Publish", "Sync") instead of renaming it "Push" halfway through.
export interface PendingPush {
    readonly verb: string;
    // What is going out — "3 commits across 2 repos", "intentic's branch".
    readonly what: string;
    readonly targets: readonly SyncTarget[];
}

// Which half of the flow is in flight. Undefined the moment it settles: nothing is "running" while a question
// is waiting, and the two states drive different surfaces.
export type PushStage = "checking" | "pushing";

/* An outcome the user has to answer. Raised only for red — a pass is not a question, and phrasing it as one is
 * how the old dialog earned its "why am I being asked this" reputation. */
export interface PushQuestion {
    // Four words at most: it is read at a glance, from a view the user may have walked back into.
    readonly title: string;
    // The command, drawn in the monospace it wears while the check is still going, so the line reads the same
    // either side of the verdict. Absent for a push that git itself refused — there is no command to name, and
    // setting a repo in that slot would make the sentence claim something was run.
    readonly command?: string;
    // The predicate that follows it: what happened, in prose.
    readonly detail: string;
    /* `checks` still has a push to send, so the answer is Push anyway or hand it to an agent. `push` is the send
     * itself having failed — there is nothing to override, and each repo carries its own reason on its own row. */
    readonly kind: "checks" | "push";
}

// How long the panel keeps saying "Pushed" after a green run. Long enough to be caught on the way back from
// wherever the user was, short enough that it is gone before it becomes furniture. A pass is not news that
// needs preserving: the outgoing work being gone is the durable half of the answer.
const PUSHED_NOTE_MS = 8_000;

const pending = shallowRef<PendingPush | undefined>(undefined);
const stage = ref<PushStage | undefined>(undefined);
// When the current stage began — what the elapsed readouts count from. Taken from the client rather than the
// run, because it has to cover the push half too, and the two halves must count in the same clock.
const since = ref(0);
const question = shallowRef<PushQuestion | undefined>(undefined);
// The fix session proposed for a failed check. shallowRef because a Conversation owns its own refs
// (agents/sessionSuggestion.ts), and composed ONCE so edits to its text and model survive every re-render and
// every navigation between the failure and the decision.
const proposedFix = shallowRef<Conversation | undefined>(undefined);
const pushed = shallowRef<PendingPush | undefined>(undefined);
let pushedTimer: ReturnType<typeof setTimeout> | undefined;

/* The agent settings in force when the button was pressed, carried rather than re-read at settle time. The
 * proposal is composed minutes later and possibly from no mounted surface at all, and "what was configured when
 * you asked" is the honest answer anyway. */
let fixWith: { model?: string; effort?: string } = {};

/* The git actions and the sandbox's identity, captured on the first call from a mounted surface. ONLY the
 * module-level halves of useChanges are ever read through this — `syncAll`, `actionBusy` and `failures` are one
 * per app rather than one per caller — so the capture stays good after the surface that made it has gone, which
 * is precisely the situation this flow exists to survive. The query-backed halves (`repos`, `outgoing`) are the
 * panel's business and are not touched here. */
let git: ReturnType<typeof useChanges> | undefined;
let sandboxId: ReturnType<typeof useSandbox>["activeSandboxId"] | undefined;

const prepush = usePrepush();

/* HOW LONG THIS SUITE USUALLY TAKES, remembered across runs. Waiting is bearable when you know the size of it,
 * and leaving is comfortable when you know roughly when to come back — which is the difference between a
 * progress readout and a progress readout that lets someone stop watching.
 *
 * Per sandbox, because the command is: two workspaces have two suites. localStorage rather than the daemon,
 * mirroring the commit draft — it is a client-side convenience, and the daemon deliberately keeps nothing about
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
const rememberTypical = (run: PrepushRun): void => {
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
};

// Back to rest, having sent what was asked for. The note is the only thing left, and it expires by itself.
const done = (push: PendingPush): void => {
    pending.value = undefined;
    stage.value = undefined;
    question.value = undefined;
    proposedFix.value = undefined;
    prepush.forget();
    pushed.value = push;
    clearTimeout(pushedTimer);
    pushedTimer = setTimeout(() => (pushed.value = undefined), PUSHED_NOTE_MS);
};

/* A batch of git actions the user started while the suite ran — a commit, a fetch, a discard — holds the
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

/* Send it. The failures useChanges files per repo ARE the outcome — the batch carries on past a repo that
 * refused, so "did this push go" is a question about which scopes came back marked, not about a thrown error. */
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
    const only = refused.length === 1 ? git!.failures.value.get(refused[0]!) : undefined;
    question.value = {
        kind: `push`,
        title: `${push.verb} failed`,
        // One repo can say what git said; several cannot share a line, and each row in the panel is already
        // carrying its own reason under the repo that produced it.
        detail: only === undefined ? `${refused.length} repos refused it — each row says why.` : `${refused[0]}: ${only.detail}`,
    };
};

export function usePushFlow() {
    git ??= useChanges();
    const { settings } = useSandboxSettings();
    const agentRun = useAgentRunModel();
    if (sandboxId === undefined) {
        sandboxId = useSandbox().activeSandboxId;
        watch(sandboxId, (id) => readTypical(id), { immediate: true });
    }

    /* THE ONE DOOR. Every Push, Sync and Publish in the app arrives here — the sync bar's button and each repo
     * row's pill alike — so the check cannot be walked around by taking a different route to the same verb.
     *
     * A pull-only sync passes straight through: nothing leaves the machine, so there is nothing to check. So
     * does a workspace with no check configured — and both still report their outcome, because "did my push
     * go" is a question the user asks whether or not a suite was involved. */
    const askSync = (verb: string, what: string, targets: readonly SyncTarget[]): void => {
        if (stage.value !== undefined) {
            return;
        }
        const push: PendingPush = { verb, what, targets };
        const command = prepushCommandOf(settings.value?.rules ?? []);
        if (command === `` || !targets.some((target) => target.push)) {
            void send(push);
            return;
        }
        // The HEAD of the agent-run list — the entry the daemon would reach for — rather than the raw setting:
        // this is composed into a draft the user can see and re-point, so it has to name a model that can
        // actually be sent. `quickModelKey` because composeSession takes the pinned `${provider}:${model}` form.
        const head = agentRun.choice.value;
        fixWith = { ...(head === undefined ? {} : { model: quickModelKey(head) }), effort: settings.value?.agentRunEffort };
        enter(push, `checking`);
        void prepush.start().then((settled) => {
            rememberTypical(settled);
            /* Still ours, and still the half of the flow that was waiting on it. Either guard failing means the
             * user has already answered — pushed anyway, dismissed, or started another sync — and a verdict
             * arriving after the decision has nobody to interrupt. */
            if (pending.value !== push || stage.value !== `checking`) {
                return;
            }
            if (settled.status === `passed`) {
                void send(push);
                return;
            }
            stage.value = undefined;
            question.value = { kind: `checks`, title: checkOutcome(settled), command: settled.command, detail: fixSummary(settled) };
            /* `error` and `cancelled` get no fix proposal. The command could not run, or the user stopped it —
             * either way nothing is known to be wrong with the code, and an agent sent after it would hunt a bug
             * that isn't there. */
            if (settled.status === `failed`) {
                proposedFix.value = composeSession({
                    prompt: fixPrompt(settled),
                    ...fixWith,
                    // Isolated, like any other fleet agent: the work under test is committed on a branch, so the
                    // fix belongs in a worktree of its own and arrives as a diff to review rather than as edits
                    // landing underneath the push the user is still deciding about.
                    isolated: true,
                });
            }
        });
    };

    /* Push anyway — the answer that is always available, during the run and after a failure, and which never
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

    // Let it go unanswered — the push does not happen, and nothing is left running that was not already. The
    // suite is not killed for the same reason Push anyway does not kill it.
    const dismiss = (): void => {
        pending.value = undefined;
        stage.value = undefined;
        question.value = undefined;
        proposedFix.value = undefined;
        prepush.forget();
    };

    // Hand the failure to an agent. The push does NOT go: the point of accepting the fix is that this tree is
    // not the one to push, and the agent's diff comes back for review like any other.
    const startFix = (): void => {
        const fix = proposedFix.value;
        dismiss();
        if (fix !== undefined) {
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
        // Whether anything at all is in flight — what the rail draws its spinner on.
        running: computed(() => stage.value !== undefined),
        // The command being run, for the line that says what is happening. From the run while there is one, from
        // settings in the moment before the first poll answers.
        command: computed(() => (prepush.run.value.command === `` ? prepushCommandOf(settings.value?.rules ?? []) : prepush.run.value.command)),
        // The check's terminal, where it exists — absent on a sandbox with no tmux wrapper, where the suite ran
        // in an invisible shell and a button would only open an empty panel.
        terminal: prepush.terminal,
        typicalMs: computed(() => typicalMs.value),
        showTerminal: prepush.showTerminal,
        askSync,
        pushAnyway,
        startFix,
        stopChecks,
        dismiss,
    };
}
