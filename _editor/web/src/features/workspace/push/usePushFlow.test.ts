import { resetSandboxScope } from "@intentic/extension-api";
import { type AgentSummary, type MainlinePush, type MainlineStatus, type PushRun, pushFindingsFixBase } from "@intentic/sandbox-contract";
import { computed, ref, shallowRef } from "vue";
import { freshImport, mocked } from "@intentic/testing/bun";
import { refusalSummary } from "../health/fixProposal";
import { modelLabelFor } from "../../chat/accounts/providerCatalog";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";

// No case here mounts a component: a push must finish, send, and raise its question even after the panel that
// started it is gone. Each mock owns its state and resets it below, and the flow itself is evaluated afresh, so
// every case opens on a clean flow and clean seams. Nothing above imports the flow: a mock that ADDS a name the
// real module does not export only reaches a graph the mocks were registered before.

/* The watcher's stamp, which decides whether a verdict is still about the tree in front of the user. */
jest.mock(`../changes/live/useWorkspaceLive`, () => {
    let lastAt = 1;
    return {
        workspaceChangedSince: (at: number) => lastAt === 0 || lastAt > at,
        // A file landing in the tree, as the daemon's watcher would report it.
        writeToTree: (): void => void (lastAt = Date.now()),
        quietTree: (): void => void (lastAt = 1),
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

// The main line as the daemon serves it, where it filed the refused push, and the hand-over the press asks it for.
// One status for the file, like the real query's, so a case sets what was filed and the flow reads that same one.
const mainlineStatus = shallowRef<MainlineStatus | undefined>(undefined);
jest.mock(`../../agents/mainline/useMainline`, () => ({
    useMainline: () => computed(() => mainlineStatus.value),
    handPushFindings: jest.fn(async () => `push-fix-opened`),
}));
jest.mock(`../../agents/mainline/openLanded`, () => ({ openLandConversation: jest.fn() }));

// The fleet as the stream keeps it: what the card's attempt is read off. A shared ref, like the real module's, so a case
// sets the roster and the flow reads that same one.
jest.mock(`../../agents/fleet/useAgents-registry`, () => ({ registry: shallowRef<AgentSummary[]>([]) }));
jest.mock(`../../agents/fleet/useAgents-actions`, () => ({ open: jest.fn() }));

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
// A fix agent as the roster reports it; `status` is what each case is about.
const agent = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    model: `claude-opus-4-6`,
    attention: { ...NO_ATTENTION },
    updatedAt: 1_000,
    ...over,
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
    const mainline = await import(`../../agents/mainline/useMainline`);
    const opened = await import(`../../agents/mainline/openLanded`);
    const live = (await import(`../changes/live/useWorkspaceLive`)) as unknown as { writeToTree: () => void; quietTree: () => void };
    // As with the seams above: the stamp is the mock's own, so each case opens on a tree nobody has written to.
    live.quietTree();
    const fleet = await import(`../../agents/fleet/useAgents-registry`);
    const opener = await import(`../../agents/fleet/useAgents-actions`);
    const module = await freshImport<typeof import("./usePushFlow")>("./usePushFlow", import.meta.url);
    // The flow captures useChanges on its first call; singletons carry over from the last case.
    const git = changes.useChanges();
    git.actionBusy.value = false;
    git.failures.value = new Map();
    // As above: the fleet mocks' refs are the mocks' own, so each case starts from an empty roster.
    fleet.registry.value = [];
    mainlineStatus.value = undefined;
    return {
        git,
        writeToTree: live.writeToTree,
        fleet,
        mainline: mainlineStatus,
        handPushFindings: mainline.handPushFindings,
        openConversation: opened.openLandConversation,
        open: opener.open,
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

// The refusal as the daemon filed it before the run read as settled (push-checks-store.ts, fileRefusal): a push whose
// one finding is what the hook said, which names the attempt at it (pushFindingsFixBase).
const REFUSED: MainlinePush = {
    project: `intentic`,
    id: `refused-x`,
    at: 5_000,
    head: `h1`,
    commits: 0,
    refused: true,
    findings: [{ id: `check:pre-push:z`, kind: `check`, check: `pre-push`, source: `pre-push`, recheckable: false, text: `typecheck failed`, state: `open` }],
};
const filed = (loaded: Loaded): string => {
    loaded.mainline.value = { projects: [], recent: [], pushes: [REFUSED] };
    return pushFindingsFixBase([REFUSED], `intentic`)!;
};

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
    const staged = { pending: flow.pending.value?.what, asked: flow.question.value !== undefined, fix: flow.proposedFix.value !== undefined };

    resetSandboxScope();

    expect(staged).toEqual({ pending: `3 commits`, asked: true, fix: true });
    expect({
        pending: flow.pending.value,
        running: flow.running.value,
        question: flow.question.value,
        fix: flow.proposedFix.value,
        held: flow.held.value,
    }).toEqual({
        pending: undefined,
        running: false,
        question: undefined,
        fix: undefined,
        held: undefined,
    });
});

// The case the rewrite is for: a verdict lands on a flow whose panel is long gone, and a second caller
// (notice, rail) sees the same question, not a fresh empty one.
test(`a hook's refusal raises a question that outlives the surface that asked`, async () => {
    const loaded = await load();
    const { flow, handPushFindings, usePushFlow } = loaded;
    await pushRefused(loaded);

    expect(flow.pushed.value).toBeUndefined();
    // Proposed, not yet asked for: which conversation the press opens is the daemon's to decide at the press, against
    // the fleet as it stands then, so nothing is started until somebody asks for it.
    expect(flow.proposedFix.value).toEqual({ project: `intentic` });
    expect(handPushFindings).not.toHaveBeenCalled();

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
    const proposal = flow.proposedFix.value;

    flow.dismiss();
    expect(flow.question.value).toBeUndefined();
    expect(flow.held.value).toMatchObject({ question: asked!, fix: proposal!, runs: [run] });
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
    const proposal = flow.proposedFix.value;
    flow.dismiss();

    flow.reopen();
    expect(flow.question.value).toEqual(asked);
    expect(flow.proposedFix.value).toEqual(proposal);
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

test(`a push the repository's own hook refused asks with the run, and proposes the hand-over of what the daemon filed`, async () => {
    const loaded = await load();
    const { flow, pushTerminal, handPushFindings, openConversation } = loaded;
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
    expect(flow.proposedFix.value).toEqual({ project: `intentic` });
    await flow.startFix();
    // The daemon's hand-over, the same the Main line makes, and the conversation it answers is opened.
    expect(handPushFindings).toHaveBeenCalledWith(`intentic`, undefined, undefined);
    expect(openConversation).toHaveBeenCalledWith(`push-fix-opened`);
});

// The workspace's own repository is the project with no folder.
test(`a refusal in the workspace root proposes the root project's hand-over`, async () => {
    const { flow, git } = await load();
    const run = refusedBy(`hook`, { repo: `root` });
    git.failures.value = new Map([[`root`, { action: `Push failed`, detail: refusalSummary(run), run }]]);
    flow.askSync(`Push`, `3 commits`, [{ repo: `root`, pull: false, push: true }]);
    await flush();

    expect(flow.proposedFix.value).toEqual({ project: `` });
});

// Accepting the proposal hands the tree to the agent instead of pushing, answering the question rather than
// leaving it open.
test(`handing the failure to an agent opens its conversation and drops the push`, async () => {
    const loaded = await load();
    const { flow, git, openConversation } = loaded;
    await pushRefused(loaded);
    filed(loaded);
    expect(flow.attempt.value).toBeUndefined();

    await flow.startFix();
    expect(openConversation).toHaveBeenCalledWith(`push-fix-opened`);
    expect(git.syncAll).toHaveBeenCalledTimes(1);
    expect(flow.question.value).toBeUndefined();
    expect(flow.pending.value).toBeUndefined();
});

test(`starting a fix with a picked model hands the pick to the daemon`, async () => {
    const loaded = await load();
    const { flow, handPushFindings } = loaded;
    await pushRefused(loaded);
    const pick = { provider: `cursor`, model: `composer-2.5`, label: `Composer 2.5` };

    await flow.startFix(pick);
    expect(handPushFindings).toHaveBeenCalledWith(`intentic`, pick, undefined);
    expect(flow.question.value).toBeUndefined();
    expect(flow.pending.value).toBeUndefined();
});

/* ONE FAILURE, MANY ATTEMPTS, ONE LIVE ANSWER: the daemon plans each press; the card reads what it filed. */

// The complaint this exists for: a second press used to re-send the whole opening prompt into the same session, with
// nothing on the card saying an agent had already tried.
test(`an attempt that ended is shown before the press, and the press asks the daemon to carry on`, async () => {
    const loaded = await load();
    const { flow, fleet, handPushFindings } = loaded;
    await pushRefused(loaded);
    const base = filed(loaded);
    fleet.registry.value = [agent(base, { status: `error`, failure: `no capacity`, diff: { files: 3, insertions: 8, deletions: 1 } })];

    expect(flow.attempt.value?.stance.kind).toBe(`ended`);
    expect(flow.attemptOnOffer.value).toEqual({
        summary: `Attempt 1 · ${modelLabelFor(`claude`, `claude-opus-4-6`)} · agent failed · 3 files on its branch`,
        continuable: true,
    });

    await flow.startFix(undefined, `continue`);
    expect(handPushFindings).toHaveBeenCalledWith(`intentic`, undefined, `continue`);
});

test(`start over over a running attempt is the daemon's to do, and the card offers only that`, async () => {
    const loaded = await load();
    const { flow, fleet, handPushFindings } = loaded;
    await pushRefused(loaded);
    const base = filed(loaded);
    fleet.registry.value = [agent(base, { status: `running` })];
    // Still in play: the slot is a chip, and the picker offers Start over alone.
    expect(flow.attempt.value?.stance.ongoing).toBe(true);
    expect(flow.attemptOnOffer.value?.continuable).toBe(false);

    await flow.startFix(undefined, `start-over`);
    expect(handPushFindings).toHaveBeenCalledWith(`intentic`, undefined, `start-over`);
    expect(flow.question.value).toBeUndefined();
});

// The race the derived id exists to prevent: a plain press over a working agent opens it rather than sending again.
test(`a plain press over an attempt still in play opens it and keeps the question`, async () => {
    const loaded = await load();
    const { flow, fleet, handPushFindings, open } = loaded;
    await pushRefused(loaded);
    const base = filed(loaded);
    fleet.registry.value = [agent(base, { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } })];

    await flow.startFix();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: base }));
    expect(handPushFindings).not.toHaveBeenCalled();
    expect(flow.question.value).toMatchObject({ title: expect.any(String), detail: expect.any(String) });
});

test(`a landed attempt is history, and the card offers a fresh press`, async () => {
    const loaded = await load();
    const { flow, fleet } = loaded;
    await pushRefused(loaded);
    const base = filed(loaded);
    fleet.registry.value = [agent(base, { status: `landed` })];

    expect(flow.attempt.value).toBeUndefined();
});

// The card must never say nothing: a press the daemon refused says why and keeps the question.
test(`a press the daemon refused says why and keeps the question`, async () => {
    const loaded = await load();
    const { flow, handPushFindings, openConversation } = loaded;
    await pushRefused(loaded);
    mocked(handPushFindings).mockRejectedValueOnce(new Error(`nothing is open in intentic`));

    await flow.startFix();
    expect(flow.fixError.value).toBe(`nothing is open in intentic`);
    expect(flow.fixBusy.value).toBe(false);
    expect(openConversation).not.toHaveBeenCalled();
    expect(flow.question.value).toMatchObject({ title: expect.any(String), detail: expect.any(String) });
});

// An attempt the daemon already has running refuses a second; the one it means is the one to watch.
test(`a press the daemon answers as busy opens the attempt it named`, async () => {
    const loaded = await load();
    const { flow, fleet, handPushFindings, open } = loaded;
    await pushRefused(loaded);
    const base = filed(loaded);
    fleet.registry.value = [agent(base, { status: `error`, failure: `no capacity` })];
    mocked(handPushFindings).mockRejectedValueOnce(new SandboxHttpError(409, `an agent is already working on it`));

    await flow.startFix();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: base }));
    expect(flow.fixError.value).toBeUndefined();
});

// A rejected ref or a dead host says nothing about the code, so there's nothing to send an agent after; the
// card carries git's reason instead.
test(`a push the remote rejected asks with git's reason and proposes no fix`, async () => {
    const loaded = await load();
    const { flow, handPushFindings } = loaded;
    await pushRefused(loaded, refusedBy(`remote`, { reason: `! [rejected] main -> main (fetch first)` }));

    expect(flow.question.value).toEqual({
        title: `Push failed`,
        command: `git push origin main`,
        detail: `was rejected by the remote: ! [rejected] main -> main (fetch first).`,
    });
    expect(flow.proposedFix.value).toBeUndefined();
    await flow.startFix();
    expect(handPushFindings).not.toHaveBeenCalled();
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
    const { flow, handPushFindings } = loaded;
    await pushRefused(loaded, refusedBy(undefined, { timedOut: true, reason: undefined, output: `` }), `Publish failed`);

    expect(flow.question.value).toEqual({
        title: `Publish timed out`,
        command: `git push origin main`,
        detail: `never finished: it hit its time limit and was killed.`,
    });
    expect(flow.proposedFix.value).toBeUndefined();
    await flow.startFix();
    expect(handPushFindings).not.toHaveBeenCalled();
});
