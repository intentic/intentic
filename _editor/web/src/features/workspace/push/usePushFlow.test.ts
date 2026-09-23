import { resetSandboxScope } from "@intentic/extension-api";
import { type AgentSummary, fixAttemptId, type PushRun, pushFixConversationId } from "@intentic/sandbox-contract";
import { computed, ref, shallowRef } from "vue";
import { freshImport, mocked } from "@intentic/testing/bun";
import { fixSignature, pushFixPrompt, pushNudgePrompt, refusalSummary } from "../health/fixProposal";
import { modelLabelFor } from "../../chat/accounts/providerCatalog";

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

// The pinned entry carries its own effort, so the tier the proposal names comes off the entry, not a shared setting.
// Filed under `pre-push-fix`, this flow's own job.
jest.mock(`../../sandbox/overview/useSandboxSettings`, () => ({
    useSandboxSettings: () => ({
        settings: ref({ modelRoles: { "pre-push-fix": [{ provider: `claude`, model: `claude-sonnet-4-5`, effort: `high` }] } }),
    }),
}));

// Resolves against what this sandbox can reach, so the proposal names a model that can actually be sent; provider
// readiness is a different suite's business.
jest.mock(`../../chat/session/access`, () => ({ providerReady: () => true }));

jest.mock(`../../agents/fleet/sessionSuggestion`, () => ({
    composeSession: jest.fn((draft: { prompt: string }) => ({
        draft,
        selection: { apply: jest.fn(), account: { value: undefined }, harness: { value: undefined } },
    })),
    startSession: jest.fn(),
}));

// The fleet as the stream keeps it and the archive as it is pulled: what a press is planned against. Shared refs,
// like the real module's, so a case sets the roster and the flow reads that same one.
jest.mock(`../../agents/fleet/useAgents-registry`, () => {
    return { registry: shallowRef<AgentSummary[]>([]), archived: shallowRef<AgentSummary[]>([]), loadArchived: jest.fn(async () => {}) };
});
jest.mock(`../../agents/fleet/useAgents-archive`, () => ({ archive: jest.fn(async () => {}) }));
jest.mock(`../../agents/fleet/agentActions`, () => ({ stopAgent: jest.fn(async () => {}) }));
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
    const suggestion = await import(`../../agents/fleet/sessionSuggestion`);
    const live = (await import(`../changes/live/useWorkspaceLive`)) as unknown as { writeToTree: () => void; quietTree: () => void };
    // As with the seams above: the stamp is the mock's own, so each case opens on a tree nobody has written to.
    live.quietTree();
    const fleet = await import(`../../agents/fleet/useAgents-registry`);
    const fleetArchive = await import(`../../agents/fleet/useAgents-archive`);
    const actions = await import(`../../agents/fleet/agentActions`);
    const opener = await import(`../../agents/fleet/useAgents-actions`);
    const module = await freshImport<typeof import("./usePushFlow")>("./usePushFlow", import.meta.url);
    // The flow captures useChanges on its first call; singletons carry over from the last case.
    const git = changes.useChanges();
    git.actionBusy.value = false;
    git.failures.value = new Map();
    // As above: the fleet mocks' refs are the mocks' own, so each case starts from an empty roster.
    fleet.registry.value = [];
    fleet.archived.value = [];
    return {
        git,
        writeToTree: live.writeToTree,
        suggestion,
        fleet,
        archive: fleetArchive.archive,
        stopAgent: actions.stopAgent,
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
    const { flow, suggestion, usePushFlow } = loaded;
    await pushRefused(loaded);

    expect(flow.pushed.value).toBeUndefined();
    // Proposed, not yet composed: which conversation the press opens is decided at the press, against the fleet as
    // it stands then, so nothing is started and no draft is written until somebody asks for it.
    expect(flow.proposedFix.value).toMatchObject({ base: expect.any(String), prompt: expect.any(String), nudge: expect.any(String) });
    expect(suggestion.composeSession).not.toHaveBeenCalled();

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

test(`a push the repository's own hook refused asks with the run, and proposes a fix from what the hook printed`, async () => {
    const loaded = await load();
    const { flow, suggestion, pushTerminal } = loaded;
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
    expect(flow.proposedFix.value).toEqual({
        // Derived the same way the flow derives it, not transcribed, since spelling a name twice invites drift.
        base: pushFixConversationId(run.repo, fixSignature(run.output)),
        prompt: pushFixPrompt([run]),
        nudge: pushNudgePrompt([run]),
    });
    await flow.startFix();
    expect(suggestion.composeSession).toHaveBeenCalledWith({
        prompt: pushFixPrompt([run]),
        model: `claude:claude-sonnet-4-5`,
        effort: `high`,
        isolated: true,
        conversationId: pushFixConversationId(run.repo, fixSignature(run.output)),
    });
});

// Accepting the proposal hands the tree to the agent instead of pushing, answering the question rather than
// leaving it open. With nobody on the failure yet, the press composes attempt 1 under the failure's own id.
test(`handing the failure to an agent starts the session and drops the push`, async () => {
    const loaded = await load();
    const { flow, git, suggestion } = loaded;
    await pushRefused(loaded);
    const proposal = flow.proposedFix.value;
    expect(flow.attempt.value).toBeUndefined();

    await flow.startFix();
    expect(suggestion.startSession).toHaveBeenCalledWith(mocked(suggestion.composeSession).mock.results[0]?.value);
    expect(suggestion.composeSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: proposal?.prompt, conversationId: proposal?.base }));
    expect(git.syncAll).toHaveBeenCalledTimes(1);
    expect(flow.question.value).toBeUndefined();
    expect(flow.pending.value).toBeUndefined();
});

test(`starting a fix with a picked model re-points the session before starting`, async () => {
    const loaded = await load();
    const { flow, suggestion } = loaded;
    await pushRefused(loaded);

    await flow.startFix({ provider: `cursor`, model: `composer-2.5`, label: `Composer 2.5` });
    const composed = mocked(suggestion.composeSession).mock.results[0]?.value as { selection: { apply: ReturnType<typeof jest.fn> } };
    expect(composed.selection.apply).toHaveBeenCalledWith({ kind: `selectModel`, pick: { provider: `cursor`, value: `composer-2.5` } });
    expect(suggestion.startSession).toHaveBeenCalledWith(composed);
    expect(flow.question.value).toBeUndefined();
    expect(flow.pending.value).toBeUndefined();
});

/* ONE FAILURE, MANY ATTEMPTS, ONE LIVE ANSWER. */

// The complaint this exists for: a second press used to re-send the whole opening prompt into the same session, with
// nothing on the card saying an agent had already tried.
test(`an attempt that ended is continued with the nudge, and the card says so before the press`, async () => {
    const loaded = await load();
    const { flow, fleet, suggestion } = loaded;
    await pushRefused(loaded);
    const { base, nudge, prompt } = flow.proposedFix.value!;
    fleet.registry.value = [agent(base, { status: `error`, failure: `no capacity`, diff: { files: 3, insertions: 8, deletions: 1 } })];

    expect(flow.attempt.value?.stance.kind).toBe(`ended`);
    expect(flow.attemptOnOffer.value).toEqual({
        summary: `Attempt 1 · ${modelLabelFor(`claude`, `claude-opus-4-6`)} · agent failed · 3 files on its branch`,
        continuable: true,
    });

    await flow.startFix();
    expect(nudge).not.toBe(prompt);
    expect(suggestion.composeSession).toHaveBeenCalledWith(expect.objectContaining({ prompt: nudge, conversationId: base }));
});

test(`start over stops a running attempt, files it away, and opens attempt 2 on the opening prompt`, async () => {
    const loaded = await load();
    const { flow, fleet, suggestion, stopAgent, archive } = loaded;
    await pushRefused(loaded);
    const { base, prompt } = flow.proposedFix.value!;
    fleet.registry.value = [agent(base, { status: `running` })];
    // Still in play: the slot is a chip, and the picker offers Start over alone.
    expect(flow.attempt.value?.stance.ongoing).toBe(true);
    expect(flow.attemptOnOffer.value?.continuable).toBe(false);

    await flow.startFix(undefined, `start-over`);
    // Set aside whichever turn it is on: the attempt goes to the archive whatever it started since.
    expect(stopAgent).toHaveBeenCalledWith(base, undefined, { live: true });
    expect(archive).toHaveBeenCalledWith([base]);
    expect(suggestion.composeSession).toHaveBeenCalledWith(expect.objectContaining({ prompt, conversationId: fixAttemptId(base, 2) }));
    expect(flow.question.value).toBeUndefined();
});

// The race the derived id exists to prevent: a plain press over a working agent opens it rather than sending again.
test(`a plain press over an attempt still in play opens it and keeps the question`, async () => {
    const loaded = await load();
    const { flow, fleet, suggestion, open } = loaded;
    await pushRefused(loaded);
    const base = flow.proposedFix.value!.base;
    fleet.registry.value = [agent(base, { status: `awaiting`, attention: { ...NO_ATTENTION, question: true } })];

    await flow.startFix();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: base }));
    expect(suggestion.composeSession).not.toHaveBeenCalled();
    expect(flow.question.value).toMatchObject({ title: expect.any(String), detail: expect.any(String) });
});

// The archive counts: an attempt set aside earlier is skipped over, since a message to it would un-archive it.
test(`an archived attempt is not resurrected, and a landed one is history`, async () => {
    const loaded = await load();
    const { flow, fleet, suggestion } = loaded;
    await pushRefused(loaded);
    const base = flow.proposedFix.value!.base;
    fleet.archived.value = [{ ...agent(base, { status: `stopped` }), open: false, unread: false, unsent: false }];
    fleet.registry.value = [agent(fixAttemptId(base, 2), { status: `landed` })];
    expect(flow.attempt.value).toBeUndefined();

    await flow.startFix();
    expect(suggestion.composeSession).toHaveBeenCalledWith(expect.objectContaining({ conversationId: fixAttemptId(base, 3) }));
});

// The card must never say nothing while an attempt is being set aside: the press is reported as busy until it lands.
test(`a press that cannot set the attempt aside says why and keeps the question`, async () => {
    const loaded = await load();
    const { flow, fleet, suggestion, stopAgent } = loaded;
    await pushRefused(loaded);
    const base = flow.proposedFix.value!.base;
    fleet.registry.value = [agent(base, { status: `running` })];
    mocked(stopAgent).mockRejectedValueOnce(new Error(`no running turn for that conversation`));

    await flow.startFix(undefined, `start-over`);
    expect(flow.fixError.value).toBe(`no running turn for that conversation`);
    expect(flow.fixBusy.value).toBe(false);
    expect(suggestion.composeSession).not.toHaveBeenCalled();
    expect(flow.question.value).toMatchObject({ title: expect.any(String), detail: expect.any(String) });
});

// One broken tree raises this question on every press of Push; the id derived from the failure lets a second
// press continue the same agent instead of minting a new one.
test(`two refusals of the same failure propose the same conversation, and a different failure does not`, async () => {
    // Read back before the next `load()`: the suggestion module's mock survives `resetModules`, so a call read
    // after the next load would wear that load's name.
    const proposedFor = async (output: string): Promise<string | undefined> => {
        const loaded = await load();
        await pushRefused(loaded, refusedBy(`hook`, { output }));
        return loaded.flow.proposedFix.value?.base;
    };
    const digest = (count: number, seconds: number, steps: string) =>
        [`verify-push: ${count} of 6 steps failed in ${seconds}s: ${steps}`, ...steps.split(`, `).map((step) => `  ✗ ${step}  exit 1`)].join(`\n`);

    const first = await proposedFor(digest(2, 12, `checkout gates, lint`));
    // The same two gates, a slower run, listed the other way round: still the same breakage, so the same agent.
    expect(await proposedFor(digest(2, 340, `lint, checkout gates`))).toBe(first);
    expect(first).toBe(pushFixConversationId(`intentic`, `checkout gates,lint`));

    // A failure that is not that failure is not that agent's work.
    expect(await proposedFor(digest(1, 12, `typecheck`))).not.toBe(first);
});

// A rejected ref or a dead host says nothing about the code, so there's nothing to send an agent after; the
// card carries git's reason instead.
test(`a push the remote rejected asks with git's reason and proposes no fix`, async () => {
    const loaded = await load();
    const { flow, suggestion } = loaded;
    await pushRefused(loaded, refusedBy(`remote`, { reason: `! [rejected] main -> main (fetch first)` }));

    expect(flow.question.value).toEqual({
        title: `Push failed`,
        command: `git push origin main`,
        detail: `was rejected by the remote: ! [rejected] main -> main (fetch first).`,
    });
    expect(flow.proposedFix.value).toBeUndefined();
    await flow.startFix();
    expect(suggestion.composeSession).not.toHaveBeenCalled();
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
    const { flow, suggestion } = loaded;
    await pushRefused(loaded, refusedBy(undefined, { timedOut: true, reason: undefined, output: `` }), `Publish failed`);

    expect(flow.question.value).toEqual({
        title: `Publish timed out`,
        command: `git push origin main`,
        detail: `never finished: it hit its time limit and was killed.`,
    });
    expect(flow.proposedFix.value).toBeUndefined();
    await flow.startFix();
    expect(suggestion.composeSession).not.toHaveBeenCalled();
});
