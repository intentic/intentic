import { resetSandboxScope } from "@intentic/extension-api";
import type { PushRun } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { freshImport } from "@intentic/testing/bun";
import { refusalSummary } from "./refusalSummary";

// No case here mounts a component: a push must finish, send, and raise its question even after the panel that
// started it is gone. Each mock owns its state and resets it below, and the flow itself is evaluated afresh, so
// every case opens on a clean flow and clean seams. Nothing above imports the flow: a mock that ADDS a name the
// real module does not export only reaches a graph the mocks were registered before.

/* The watcher's count of change batches, which decides whether a verdict is still about the tree in front of the user.
   A count, not a clock: a write in the same millisecond as the verdict is still a write since it. */
jest.mock(`../changes/live/useWorkspaceLive`, () => {
    let changes = 1;
    return {
        workspaceChangeMark: () => changes,
        workspaceChangedSince: (mark: number) => changes === 0 || changes > mark,
        // A file landing in the tree, as the daemon's watcher would report it.
        writeToTree: (): void => void (changes += 1),
        quietTree: (): void => void (changes = 1),
    };
});

jest.mock(`../changes/useChanges`, () => {
    // One of each, shared like the real module's singletons; a fresh spy per call would give the flow a different
    // `syncAll` than the one under assertion.
    const actionBusy = ref(false);
    const failures = ref(new Map<string, { action: string; detail: string; run?: PushRun }>());
    const syncAll = jest.fn(async () => {});
    return { COMMIT_SCOPE: `commit`, useChanges: () => ({ actionBusy, failures, syncAll }) };
});

// Push runs live behind useChanges (mocked above); this seam only tracks the terminal a refused push ran in,
// one per repo, like the daemon.
jest.mock(`./usePushRun`, () => {
    const sessions = new Map<string, string>();
    return {
        usePushRun: (repo: string) => ({ terminal: computed(() => sessions.get(repo)), showTerminal: jest.fn() }),
        clearPushTerminals: () => sessions.clear(),
        // Sets where a repo's push is running, as the daemon would name it.
        pushTerminal: (repo: string, session: string | undefined): void => {
            if (session === undefined) {
                sessions.delete(repo);
            } else {
                sessions.set(repo, session);
            }
        },
    };
});

const PUSH = [{ repo: `intentic`, pull: false, push: true }];

const load = async () => {
    jest.clearAllMocks();
    // Seams before the flow: each is asked for its state and put back to the start before the flow captures it.
    const changes = await import(`../changes/useChanges`);
    const pushRuns = (await import(`./usePushRun`)) as unknown as {
        pushTerminal: (repo: string, session: string | undefined) => void;
        clearPushTerminals: () => void;
    };
    pushRuns.clearPushTerminals();
    const live = (await import(`../changes/live/useWorkspaceLive`)) as unknown as { writeToTree: () => void; quietTree: () => void };
    // As with the seams above: the stamp is the mock's own, so each case opens on a tree nobody has written to.
    live.quietTree();
    const module = await freshImport<typeof import("./usePushFlow")>("./usePushFlow", import.meta.url);
    // The flow captures useChanges on its first call; singletons carry over from the last case.
    const git = changes.useChanges();
    git.actionBusy.value = false;
    git.failures.value = new Map();
    return {
        git,
        writeToTree: live.writeToTree,
        pushTerminal: pushRuns.pushTerminal,
        flow: module.usePushFlow(),
        // The same module a second caller would reach; the flow is module-level, so it hands back one instance.
        usePushFlow: module.usePushFlow,
    };
};

// The seams resolve immediately, so a macrotask boundary drains however many microtasks a path takes, rather
// than counting ticks that shift with the code.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// A refused push as the daemon settles it; `refusedBy` is who said no.
const refusedBy = (by: PushRun["refusedBy"], over: Partial<PushRun> = {}): PushRun => ({
    status: `failed`,
    repo: `intentic`,
    command: `git push origin main`,
    exitCode: 1,
    startedAt: 1_000,
    finishedAt: 5_000,
    session: `job-push`,
    output: `verify-push: typecheck failed; the push does not go\nerror: failed to push some refs to 'origin'`,
    reason: `error: failed to push some refs to 'origin'`,
    ...(by === undefined ? {} : { refusedBy: by }),
    ...over,
});

type Loaded = Awaited<ReturnType<typeof load>>;

// Files the run against its repo the way useChanges does after a refused push, then presses Push and lets it settle.
const pushRefused = async ({ flow, git }: Loaded, run: PushRun = refusedBy(`hook`), action = `Push failed`): Promise<void> => {
    git.failures.value = new Map([[run.repo, { action, detail: refusalSummary(run), run }]]);
    flow.askSync(action.split(` `)[0]!, `3 commits`, PUSH);
    await flush();
};

test(`a press sends the push at once, with nobody watching`, async () => {
    const { flow, git } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    expect(flow.running.value).toBe(true);

    await flush();
    expect(git.syncAll).toHaveBeenCalledWith(PUSH);
    expect(flow.question.value).toBeUndefined();
    expect(flow.running.value).toBe(false);
    // The only thing a success says, and it says it where the click was.
    expect(flow.pushed.value?.what).toBe(`3 commits`);
});

// A staged push names commits in one workspace, and offering to send them from another box is the most consequential
// thing a new scope (a switch, or the workspace replaced under the same id) could carry over.
test(`a new sandbox scope leaves nothing of a refused push to send, reprint or answer`, async () => {
    const loaded = await load();
    const { flow } = loaded;
    await pushRefused(loaded);
    const staged = { pending: flow.pending.value?.what, asked: flow.question.value !== undefined };

    resetSandboxScope();

    expect(staged).toEqual({ pending: `3 commits`, asked: true });
    expect({
        pending: flow.pending.value,
        running: flow.running.value,
        question: flow.question.value,
        held: flow.held.value,
    }).toEqual({
        pending: undefined,
        running: false,
        question: undefined,
        held: undefined,
    });
});

// The case the rewrite is for: a verdict lands on a flow whose panel is long gone, and a second caller
// (notice, rail) sees the same question, not a fresh empty one.
test(`a hook's refusal raises a question that outlives the surface that asked`, async () => {
    const loaded = await load();
    const { flow, usePushFlow } = loaded;
    await pushRefused(loaded);

    expect(flow.pushed.value).toBeUndefined();
    expect(flow.question.value).toMatchObject({ title: expect.any(String), detail: expect.any(String) });

    expect(usePushFlow().question.value).toEqual(flow.question.value);
});

/* CLOSING THE CARD ANSWERS NOTHING, which is what these are about. */

test(`a closed card leaves the verdict standing, with everything the card had`, async () => {
    const loaded = await load();
    const { flow, pushTerminal } = loaded;
    pushTerminal(`intentic`, `job-push`);
    const run = refusedBy(`hook`);
    await pushRefused(loaded, run);
    const asked = flow.question.value;

    flow.dismiss();
    expect(flow.question.value).toBeUndefined();
    expect(flow.held.value).toMatchObject({ question: asked!, runs: [run] });
    // Still true of the tree in front of the user: nothing has been written since it settled.
    expect(flow.heldStale.value).toBe(false);
    // The window it ran in outlives the card too, and is the only place the whole output ever was.
    expect(flow.terminal.value).toBe(`job-push`);
});

test(`reopening puts the same card back, and says it is not news`, async () => {
    const loaded = await load();
    const { flow, git } = loaded;
    await pushRefused(loaded);
    const asked = flow.question.value;
    flow.dismiss();

    flow.reopen();
    expect(flow.question.value).toEqual(asked);
    // The verb the push was asked for is back too, or Try again would have nothing to push.
    expect(flow.pending.value?.verb).toBe(`Push`);
    expect(flow.fromMemory.value).toBe(true);
    // Nothing was sent to get it back.
    expect(flow.running.value).toBe(false);
    expect(git.syncAll).toHaveBeenCalledTimes(1);
});

test(`a file written since demotes the verdict, and the next press pushes again`, async () => {
    const loaded = await load();
    const { flow, git, writeToTree } = loaded;
    await pushRefused(loaded);
    flow.dismiss();

    writeToTree();
    expect(flow.heldStale.value).toBe(true);
    // Still shown (it is what last happened), but no longer what the hook would say.
    expect(flow.held.value).toMatchObject({ question: { title: expect.any(String), detail: expect.any(String) } });

    flow.askSync(`Push`, `3 commits`, PUSH);
    expect(flow.running.value).toBe(true);
    expect(flow.held.value).toBeUndefined();
    await flush();
    expect(git.syncAll).toHaveBeenCalledTimes(2);
});

// A verdict about work that has left the machine would be a warning about a push that already went.
test(`a retry that goes retires the standing verdict`, async () => {
    const loaded = await load();
    const { flow, git } = loaded;
    await pushRefused(loaded);
    flow.dismiss();
    expect(flow.held.value).toMatchObject({ push: { verb: `Push`, what: `3 commits` } });

    flow.reopen();
    git.failures.value = new Map();
    flow.retry();
    await flush();
    expect(flow.pushed.value?.what).toBe(`3 commits`);
    expect(flow.held.value).toBeUndefined();
});

// "Did my push go" is the real question; a refused send must answer it loudly, or work on disk reads as sent.
test(`a refused push asks again instead of reporting success`, async () => {
    const { flow, git } = await load();
    git.failures.value = new Map([[`intentic`, { action: `Push failed`, detail: `rejected: non-fast-forward` }]]);
    flow.askSync(`Push`, `3 commits`, PUSH);
    await flush();

    expect(flow.pushed.value).toBeUndefined();
    expect(flow.question.value?.detail).toContain(`intentic`);
    expect(flow.question.value?.detail).toContain(`non-fast-forward`);
});

// useChanges refuses a second batch while one's in flight, so a push pressed mid-commit must wait, not drop.
test(`a push waits for a git action the user started`, async () => {
    const { flow, git } = await load();
    git.actionBusy.value = true;
    flow.askSync(`Push`, `3 commits`, PUSH);
    await flush();
    expect(git.syncAll).not.toHaveBeenCalled();
    expect(flow.running.value).toBe(true);

    git.actionBusy.value = false;
    await flush();
    expect(git.syncAll).toHaveBeenCalledWith(PUSH);
    expect(flow.pushed.value).toEqual(expect.any(Object));
});

test(`a pull-only sync goes through the same door and reports its outcome`, async () => {
    const { flow, git } = await load();
    flow.askSync(`Sync`, `2 commits`, [{ repo: `intentic`, pull: true, push: false }]);
    await flush();

    expect(flow.running.value).toBe(false);
    expect(git.syncAll).toHaveBeenCalledTimes(1);
    expect(flow.pushed.value?.what).toBe(`2 commits`);
});

test(`a push the repository's own hook refused asks with the run, and keeps the terminal it ran in`, async () => {
    const loaded = await load();
    const { flow, pushTerminal } = loaded;
    const run = refusedBy(`hook`);
    pushTerminal(`intentic`, `job-push`);
    await pushRefused(loaded, run);

    expect(flow.pushed.value).toBeUndefined();
    expect(flow.question.value).toEqual({
        title: `Push failed`,
        command: `git push origin main`,
        detail: `was refused by this repository's pre-push hook.`,
    });
    expect(flow.terminal.value).toBe(`job-push`);
});

// A rejected ref or a dead host says nothing about the code; git's own reason is the advice, and the card carries it.
test(`a push the remote rejected asks with git's reason`, async () => {
    const loaded = await load();
    const { flow } = loaded;
    await pushRefused(loaded, refusedBy(`remote`, { reason: `! [rejected] main -> main (fetch first)` }));

    expect(flow.question.value).toEqual({
        title: `Push failed`,
        command: `git push origin main`,
        detail: `was rejected by the remote: ! [rejected] main -> main (fetch first).`,
    });
});

// A refused send is filed and stands, but never reprinted in place of a press: pressing again means ask the hook and
// the remote again.
test(`a refused push stands after the card is closed, and the next press retries rather than reprints`, async () => {
    const loaded = await load();
    const { flow, git } = loaded;
    const run = refusedBy(`remote`, { reason: `! [rejected] main -> main (fetch first)` });
    await pushRefused(loaded, run);
    const asked = flow.question.value;

    flow.dismiss();
    expect(flow.held.value).toMatchObject({ question: asked!, runs: [run] });

    flow.askSync(`Push`, `3 commits`, PUSH);
    expect(flow.running.value).toBe(true);
    await flush();
    expect(git.syncAll).toHaveBeenCalledTimes(2);
});

test(`a push that hit its ceiling is named as timed out, in the verb the user clicked`, async () => {
    const loaded = await load();
    const { flow } = loaded;
    await pushRefused(loaded, refusedBy(undefined, { timedOut: true, reason: undefined, output: `` }), `Publish failed`);

    expect(flow.question.value).toEqual({
        title: `Publish timed out`,
        command: `git push origin main`,
        detail: `never finished: it hit its time limit and was killed.`,
    });
});
