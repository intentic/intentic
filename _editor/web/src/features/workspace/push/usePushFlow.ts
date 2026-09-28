import { commandRunOutcome, type PushRun } from "@intentic/sandbox-contract";
import { sandboxRef, sandboxShallowRef, sandboxValue } from "@intentic/extension-api";
import { computed, watch } from "vue";
import { type SyncTarget, useChanges } from "../changes/useChanges";
import { workspaceChangedSince, workspaceChangeMark } from "../changes/live/useWorkspaceLive";
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
// - only a refusal raises `question`, wherever the user is: the command, git's reason, the terminal it ran in and the
//   same push again. What to do about a refusal is the owner's call; the card only says what happened.
// - nothing is lost by walking away: the question waits until it's answered.
// - closing the card is "off my screen", not "that never happened": the verdict stands (`standing`), the panel says
//   so, and the same card comes back on a press. What retires it is the world changing, never a timer.

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

/* A FAILED PUSH'S VERDICT, WHICH OUTLIVES ITS CARD. */
export interface StandingVerdict {
    readonly push: PendingPush;
    readonly question: PushQuestion;
    readonly runs: readonly PushRun[];
    // When it settled, on the reader's clock: what the panel dates it by.
    readonly at: number;
    // Where the tree stood when it settled (workspaceChangeMark): what a write since is counted against. A count rather
    // than `at`, since a write reported in the same millisecond would read as no write at all.
    readonly mark: number;
}

const standing = sandboxShallowRef<StandingVerdict | undefined>(() => undefined);
// Whether the card on screen is a verdict being reprinted rather than one that just landed; the card says so, since
// "Push failed" reads as news and this is not news.
const fromMemory = sandboxRef(() => false);
// Push runs that settled as refused behind the question: the terminal each ran in.
const refusedRuns = sandboxShallowRef<readonly PushRun[]>(() => []);
const pushed = sandboxShallowRef<PendingPush | undefined>(() => undefined);
// Expires the "Pushed" note; a switch takes the note down with its timer.
const pushedTimer = sandboxValue<ReturnType<typeof setTimeout> | undefined>(
    () => undefined,
    (timer) => clearTimeout(timer),
);

// Git actions, captured once from a mounted surface. Only useChanges's module-level halves (syncAll, actionBusy,
// failures) are read here; the query-backed halves are the panel's own.
let git: ReturnType<typeof useChanges> | undefined;

// A new push supersedes whatever was being asked, standing verdict included: the hook is about to answer again.
const enter = (push: PendingPush): void => {
    pending.value = push;
    sending.value = true;
    since.value = Date.now();
    question.value = undefined;
    refusedRuns.value = [];
    standing.value = undefined;
    fromMemory.value = false;
};

/* Every refusal raises the same question and records the same verdict material. */
const raise = (push: PendingPush, asked: PushQuestion, filed: Pick<StandingVerdict, "runs" | "at">): void => {
    question.value = asked;
    refusedRuns.value = filed.runs;
    standing.value = { push, question: asked, ...filed, mark: workspaceChangeMark() };
    fromMemory.value = false;
};

// Back on screen, unchanged, at no cost: the same words, the same terminal, the same retry.
const reopen = (): void => {
    const held = standing.value;
    if (held === undefined) {
        return;
    }
    pending.value = held.push;
    question.value = held.question;
    refusedRuns.value = held.runs;
    fromMemory.value = true;
};

// Back to rest, having sent what was asked; the note is the only thing left, and it expires on its own.
const done = (push: PendingPush): void => {
    pending.value = undefined;
    sending.value = false;
    question.value = undefined;
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

// Failures useChanges files per repo are the outcome; the batch carries on past a refusal.
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
    raise(push, refusalQuestion(push, refused), { runs, at: Date.now() });
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

/* Closing the card leaves the standing verdict and its run available. */
const dismiss = (): void => {
    pending.value = undefined;
    sending.value = false;
    question.value = undefined;
    refusedRuns.value = [];
    fromMemory.value = false;
};

export function usePushFlow() {
    git ??= useChanges();

    // The one door every Push, Sync and Publish arrives at, so every refusal is asked about the same way.
    const askSync = (verb: string, what: string, targets: readonly SyncTarget[]): void => {
        if (sending.value) {
            return;
        }
        void send({ verb, what, targets });
    };

    // The same push again, hook and all.
    const retry = (): void => {
        const push = pending.value;
        if (push !== undefined && !sending.value) {
            void send(push);
        }
    };

    return {
        pending: computed(() => pending.value),
        since: computed(() => since.value),
        question: computed(() => question.value),
        /* The verdict is hidden while the card itself explains it. */
        held: computed(() => (question.value === undefined && !sending.value ? standing.value : undefined)),
        // Whether the tree has been written to since the verdict settled, so the hook may no longer say the same.
        heldStale: computed(() => (standing.value === undefined ? false : workspaceChangedSince(standing.value.mark))),
        // Whether the card on screen is being reprinted rather than reporting a run that just ended.
        fromMemory: computed(() => fromMemory.value),
        // When the standing verdict settled, for a surface that dates it; the clock is the reader's, not this module's.
        verdictAt: computed(() => standing.value?.at),
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
        dismiss,
    };
}
