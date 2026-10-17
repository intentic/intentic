import { sandboxRef } from "@intentic/extension-api";
import { followCommandRun } from "@intentic/sandbox-contract/policy/command-run";
import type { IndexRun, IndexRunHold, IndexRunOp, IndexRunStart } from "@intentic/sandbox-contract/schemas/git/index-run";
import { formatCount } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";
import { track } from "../../app/analytics";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";

// Stage-all and commit-all as the daemon's runs (schemas/git/index-run.ts), followed here instead of held open as one
// request: over a tree of tens of thousands of files `git add -A` outlives the 45 s header deadline, and a request that
// dies there tells nobody how git ended. A dropped poll (a reconnect) is not a failed run, so following just goes on;
// the daemon joins a repeated start to the run already going, so a retry never queues a second one.

// Short enough that a quick commit doesn't feel parked, cheap since the state is memory-only on the daemon.
const POLL_MS = 500;
// A run slower than this is reported (`git_op_slow`): what the 53k-file report looked like before anyone wrote in.
export const SLOW_GIT_OP_MS = 30_000;

// What the panel draws under the commit box while a run goes (IndexRunPrompt.vue): the run as last read, and whether
// the last read failed, so "still trying" is said rather than a frozen phase.
interface FollowedRun {
    readonly run: IndexRun;
    readonly lostContact: boolean;
}
export const followedRuns = sandboxRef<ReadonlyMap<string, FollowedRun>>(() => new Map());

// A run the guardrail held, waiting on the reader: the prompt answers the first, and the next shows after it.
interface HoldQuestion {
    // Matched by id, never by identity: the list is a ref, so what it hands back is a reactive proxy of what went in.
    readonly id: number;
    readonly repo: string;
    readonly op: IndexRunOp;
    readonly hold: IndexRunHold;
    readonly answer: (go: boolean) => void;
}
export const holdQuestions = sandboxRef<readonly HoldQuestion[]>(() => []);

const show = (repo: string, followed: FollowedRun | undefined): void => {
    const next = new Map(followedRuns.value);
    if (followed === undefined) {
        next.delete(repo);
    } else {
        next.set(repo, followed);
    }
    followedRuns.value = next;
};

let asked = 0;
const ask = (repo: string, op: IndexRunOp, hold: IndexRunHold): Promise<boolean> =>
    new Promise((resolve) => {
        asked += 1;
        const id = asked;
        const question: HoldQuestion = {
            id,
            repo,
            op,
            hold,
            answer: (go) => {
                holdQuestions.value = holdQuestions.value.filter((waiting) => waiting.id !== id);
                resolve(go);
            },
        };
        holdQuestions.value = [...holdQuestions.value, question];
    });

// Measured on the daemon's clock at both ends, so a tab that slept through the run doesn't inflate it.
const reportIfSlow = (run: IndexRun): void => {
    const ms = (run.finishedAt ?? Date.now()) - (run.startedAt ?? Date.now());
    if (run.op !== undefined && ms > SLOW_GIT_OP_MS) {
        track(`git_op_slow`, { op: run.op, files: run.files?.total ?? 0, ms });
    }
};

// One start, followed to its verdict. A state naming another run means this one is gone from the daemon (a restart
// forgets runs), which is said rather than read as that other run's verdict.
const follow = async (repo: string, request: Omit<IndexRunStart, `repo`>): Promise<IndexRun> => {
    const started = await sandboxRpc.git.indexRunStart({ repo, ...request });
    show(repo, { run: started, lostContact: false });
    try {
        const settled = await followCommandRun(() => sandboxRpc.git.indexRunState({ repo }), {
            intervalMs: POLL_MS,
            onState: (run) => show(repo, { run, lostContact: false }),
            onError: () => show(repo, { run: followedRuns.value.get(repo)?.run ?? started, lostContact: true }),
        });
        if (settled === undefined || settled.id !== started.id) {
            throw new Error(t(`workspace.indexRuns.lost`, { repo }));
        }
        reportIfSlow(settled);
        return settled;
    } finally {
        show(repo, undefined);
    }
};

// Starts a stage or commit and follows it; a guardrail hold asks first and, on a yes, starts again past it. Resolves
// with the passed run, and throws a sentence for everything else: refused by git, stopped, or declined at the prompt,
// so the panel files each where it files any failure, and the typed commit message stays in its box.
export const runIndexJob = async (repo: string, request: Omit<IndexRunStart, `repo`>): Promise<IndexRun> => {
    let settled = await follow(repo, request);
    if (settled.held !== undefined) {
        if (!(await ask(repo, request.op, settled.held))) {
            throw new Error(t(`workspace.indexRuns.declined`, { count: formatCount(settled.held.files) }, settled.held.files));
        }
        settled = await follow(repo, { ...request, confirmed: true });
    }
    if (settled.status === `cancelled`) {
        throw new Error(request.op === `stage` ? t(`workspace.indexRuns.stageStopped`) : t(`workspace.indexRuns.commitStopped`));
    }
    if (settled.status !== `passed`) {
        throw new Error(settled.reason ?? t(`workspace.useChanges.gitGaveNoReason`));
    }
    return settled;
};

// The Stop beside a running run; the daemon kills git and the follow above settles it as stopped.
export const cancelIndexRun = async (repo: string): Promise<void> => {
    await sandboxRpc.git.indexRunCancel({ repo });
};
