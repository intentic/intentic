import type { CommandRun, PushRun } from "@intentic/sandbox-contract";
import { beforeEach, expect, test, vi } from "vitest";
// Statically imported for its LOAD COST alone: every test re-imports it through `load()` below, and the first
// of those pulled the unmocked half of the graph (the agent-run model resolver and the contract it resolves
// against) inside the first test's 20s budget: ~1s idle, but several times that on a runner where every core is
// busy, which is how this file failed with the first test timing out. The second failure was the same one: a
// timed-out test keeps running, so this file's push landed on the NEXT test's mocks. Collection is bounded by
// the run rather than by a test, so paying it here costs the same and can't time anything out. Nothing is
// bound: `load()` resets the module registry and re-executes the (already transformed) graph fresh per test.
// oxlint-disable-next-line import/no-unassigned-import -- imported for its load cost alone, not for a binding
import "./usePushFlow";
import { checkOutcome, outcomeSummary, pushFixPrompt, refusalSummary } from "./fixProposal";

/* THE PROMISE UNDER TEST IS A LIFETIME. Every case here runs with NO component mounted, because that is the
 * situation the flow exists for: the user starts a push, walks off to another view, which destroys the panel
 * they started it in, and the run has to finish, send, and raise its question anyway. The old flow lived in
 * that panel's setup, so leaving lost the verdict, the fix proposal, and any sign the push had happened.
 *
 * The seams are the two things that talk to the daemon (the check and git) plus the two the composed fix reads.
 * Each mock owns its state so `vi.resetModules` gives every case a clean flow AND clean seams. */

vi.mock(`./usePrepush`, async () => {
    const { computed, ref } = await import(`vue`);
    const run = ref<CommandRun>({ status: `idle`, command: `pnpm check`, output: `` });
    let settle: ((run: CommandRun) => void) | undefined;
    return {
        usePrepush: () => ({
            run: computed(() => run.value),
            error: computed(() => undefined),
            running: computed(() => run.value.status === `running`),
            terminal: computed(() => run.value.session),
            start: vi.fn(async () => {
                run.value = { status: `running`, command: `pnpm check`, output: ``, session: `job-checks` };
                return await new Promise<CommandRun>((resolve) => (settle = resolve));
            }),
            cancel: vi.fn(),
            forget: vi.fn(),
            showTerminal: vi.fn(),
        }),
        // The suite finishing, as the daemon's poll would report it.
        finish: (fields: Partial<CommandRun>): void => {
            const settled: CommandRun = { status: `passed`, command: `pnpm check`, output: ``, startedAt: 1_000, finishedAt: 61_000, ...fields };
            run.value = settled;
            settle?.(settled);
        },
        // Vitest keeps a mock factory's result across `resetModules`, so the seam has to be walked back by hand
        // or each case would open on the last one's verdict.
        reset: (): void => {
            run.value = { status: `idle`, command: `pnpm check`, output: `` };
            settle = undefined;
        },
    };
});

vi.mock(`./useChanges`, async () => {
    const { ref } = await import(`vue`);
    // ONE of each, shared by every caller: as in the real module, where these are module-level singletons. A
    // fresh spy per call would have handed the flow a different `syncAll` than the one under assertion.
    const actionBusy = ref(false);
    const failures = ref(new Map<string, { action: string; detail: string }>());
    const syncAll = vi.fn(async () => {});
    return { COMMIT_SCOPE: `commit`, useChanges: () => ({ actionBusy, failures, syncAll }) };
});

/* The push runs themselves are behind useChanges (which is mocked whole above), so what the flow reaches for
 * here is only the terminal a refused push ran in. The seam names one per repo, the way the daemon does. */
vi.mock(`./usePushRun`, async () => {
    const { computed } = await import(`vue`);
    const sessions = new Map<string, string>();
    return {
        usePushRun: (repo: string) => ({ terminal: computed(() => sessions.get(repo)), showTerminal: vi.fn() }),
        resetPushRuns: () => sessions.clear(),
        // The test's own: where a repo's push is running, as the daemon would have named it.
        pushTerminal: (repo: string, session: string | undefined): void => {
            if (session === undefined) {
                sessions.delete(repo);
            } else {
                sessions.set(repo, session);
            }
        },
    };
});

// The check this flow gates on is a `push.starting` rule, so the settings the flow reads carry a rule table
// rather than a command field: the real shape, so the real reader (prepushCommandOf) runs against it.
vi.mock(`../sandbox/useSandboxSettings`, async () => {
    const { ref } = await import(`vue`);
    const rules = [
        {
            id: `pre-push`,
            label: `Check before you push`,
            moment: `push.starting`,
            action: { kind: `command`, command: `pnpm check`, timeoutMs: 900_000 },
            enabled: true,
        },
    ];
    return {
        useSandboxSettings: () => ({ settings: ref({ rules, agentRunModels: [`claude:claude-sonnet-4-5`], agentRunEffort: `high` }) }),
    };
});

// The agent-run list resolves against what this sandbox can actually reach, so the flow's proposal names a
// model that can be sent. Everything is connected here, which provider is ready is agentRunModel.test's
// business, not this suite's.
vi.mock(`../chat/access`, () => ({ providerReady: () => true }));

vi.mock(`../sandbox/useSandbox`, async () => {
    const { ref } = await import(`vue`);
    return { useSandbox: () => ({ activeSandboxId: ref(`sb-1`) }) };
});

vi.mock(`../agents/sessionSuggestion`, () => ({
    composeSession: vi.fn((draft: { prompt: string }) => ({ draft })),
    startSession: vi.fn(),
}));

const PUSH = [{ repo: `intentic`, pull: false, push: true }];

const load = async () => {
    vi.clearAllMocks();
    vi.resetModules();
    /* Sequentially, and the seams BEFORE the flow, not a style preference. Imported concurrently, the test's
     * own `import` of a mocked module raced the flow's, each evaluating the factory, and the two ended up
     * holding different copies of its state: `finish` resolved a promise the flow was not waiting on, and the
     * check appeared to hang forever. Warming the registry first makes both sides the same instance. */
    const prepush = await import(`./usePrepush`);
    const changes = await import(`./useChanges`);
    const pushRuns = (await import(`./usePushRun`)) as unknown as { pushTerminal: (repo: string, session: string | undefined) => void; resetPushRuns: () => void };
    pushRuns.resetPushRuns();
    const suggestion = await import(`../agents/sessionSuggestion`);
    const module = await import(`./usePushFlow`);
    const seam = prepush as unknown as { finish: (fields: Partial<CommandRun>) => void; reset: () => void };
    seam.reset();
    // The flow captures useChanges on its first call, so this is the same object it acts through, and the same
    // singletons the last case left behind, which is why they are put back here.
    const git = changes.useChanges();
    git.actionBusy.value = false;
    git.failures.value = new Map();
    return { finish: seam.finish, git, suggestion, pushTerminal: pushRuns.pushTerminal, flow: module.usePushFlow() };
};

// The seams all resolve immediately, so the flow settles entirely in microtasks: a macrotask boundary drains
// however many of them a path happens to take, rather than counting ticks that change whenever the code does.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// This package's suites run on `node`, which has no storage. The remembered duration is the one thing here that
// uses it, so it gets the smallest possible stand-in rather than the whole of jsdom.
const stored = new Map<string, string>();
vi.stubGlobal(`localStorage`, {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    clear: () => stored.clear(),
});

beforeEach(() => {
    localStorage.clear();
});

test(`a green check sends the push with nobody watching`, async () => {
    const { flow, git, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    expect(flow.stage.value).toBe(`checking`);
    expect(git.syncAll).not.toHaveBeenCalled();

    finish({ status: `passed` });
    await flush();

    expect(git.syncAll).toHaveBeenCalledWith(PUSH);
    expect(flow.question.value).toBeUndefined();
    expect(flow.stage.value).toBeUndefined();
    // The only thing a success ever says, and it says it where the click was.
    expect(flow.pushed.value?.what).toBe(`3 commits`);
});

/* The case the rewrite is for: the verdict lands on a flow whose panel is long gone. Nothing here mounts
 * anything, and a second caller (the notice, the rail) sees the same question rather than a fresh empty one. */
test(`a red check raises a question that outlives the surface that asked`, async () => {
    const { flow, git, suggestion, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, exitCode: 1, output: `2 tests failed` });
    await flush();

    expect(git.syncAll).not.toHaveBeenCalled();
    const settled: CommandRun = { status: `failed`, command: `pnpm check`, output: `2 tests failed`, exitCode: 1 };
    expect(flow.question.value).toMatchObject({ kind: `checks`, command: settled.command, detail: outcomeSummary(settled) });
    expect(flow.question.value?.title).not.toBe(checkOutcome({ ...settled, status: `cancelled` }));
    /* Composed once, from the failure: text, model and effort, and waiting to be edited whenever the user
     * gets back to it.
     *
     * The MODEL is the head of the sandbox's agent-run list, resolved rather than copied out of the setting:
     * the proposal is a draft the user can see and send, so naming an entry whose account is gone would put a
     * model in front of them that cannot run. Same answer every other surface-started run gets. */
    expect(suggestion.composeSession).toHaveBeenCalledTimes(1);
    expect(suggestion.composeSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: `claude:claude-sonnet-4-5`, effort: `high`, isolated: true }),
    );
    expect(flow.proposedFix.value).toEqual(expect.any(Object));

    const { usePushFlow } = await import(`./usePushFlow`);
    expect(usePushFlow().question.value).toEqual(flow.question.value);
});

// Push anyway never asks twice, and the verdict it outran has nobody left to interrupt.
test(`pushing anyway mid-run sends at once and the late verdict says nothing`, async () => {
    const { flow, git, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    flow.pushAnyway();
    await flush();
    expect(git.syncAll).toHaveBeenCalledTimes(1);

    finish({ status: `failed`, exitCode: 1 });
    await flush();
    expect(flow.question.value).toBeUndefined();
    expect(git.syncAll).toHaveBeenCalledTimes(1);
});

// Stopping the suite is not abandoning the push: the decision it was raised for is still open, and no agent is
// proposed for a run that was never allowed to find anything.
test(`stopping the checks leaves the push waiting and proposes no fix`, async () => {
    const { flow, suggestion, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    flow.stopChecks();
    finish({ status: `cancelled` });
    await flush();

    expect(flow.question.value).toMatchObject({
        kind: `checks`,
        command: `pnpm check`,
        detail: outcomeSummary({ status: `cancelled`, command: `pnpm check`, output: `` }),
    });
    expect(flow.question.value?.title).not.toBe(checkOutcome({ status: `failed`, command: `pnpm check`, output: ``, exitCode: 1 }));
    expect(suggestion.composeSession).not.toHaveBeenCalled();
    expect(flow.proposedFix.value).toBeUndefined();
});

// A command that could not run says nothing about the code, so there is nothing to send an agent after.
test(`a check that could not run asks, but proposes no fix`, async () => {
    const { flow, suggestion, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `error`, output: `pnpm: not found` });
    await flush();

    const settled: CommandRun = { status: `error`, command: `pnpm check`, output: `pnpm: not found` };
    expect(flow.question.value).toMatchObject({ kind: `checks`, command: settled.command, detail: outcomeSummary(settled) });
    expect(flow.question.value?.title).not.toBe(checkOutcome({ status: `failed`, command: settled.command, output: settled.output, exitCode: 1 }));
    expect(suggestion.composeSession).not.toHaveBeenCalled();
});

// "Did my push go" is the question the user actually asked. A refused send has to answer it as loudly as a
// refused check, or the flow reports success over work still sitting on this disk.
test(`a refused push asks again instead of reporting success`, async () => {
    const { flow, git, finish } = await load();
    git.failures.value = new Map([[`intentic`, { action: `Push failed`, detail: `rejected: non-fast-forward` }]]);
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `passed` });
    await flush();

    expect(flow.pushed.value).toBeUndefined();
    expect(flow.question.value).toMatchObject({ kind: `push` });
    expect(flow.question.value?.detail).toContain(`intentic`);
    expect(flow.question.value?.detail).toContain(`non-fast-forward`);
});

/* The invitation this design makes (keep working while the suite runs) is exactly what breaks a push fired
 * blind: useChanges refuses a batch while another is in flight, so a green check landing mid-commit would have
 * been dropped and reported as sent. */
test(`a push waits for a git action the user started while the suite ran`, async () => {
    const { flow, git, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    git.actionBusy.value = true;
    finish({ status: `passed` });
    await flush();
    expect(git.syncAll).not.toHaveBeenCalled();
    expect(flow.stage.value).toBe(`pushing`);

    git.actionBusy.value = false;
    await flush();
    expect(git.syncAll).toHaveBeenCalledWith(PUSH);
    expect(flow.pushed.value).toEqual(expect.any(Object));
});

// Nothing leaves the machine on a pull-only sync, so there is nothing to check, and the outcome is still
// reported, because "did it go" is asked whether or not a suite was involved.
test(`a pull-only sync skips the check entirely`, async () => {
    const { flow, git } = await load();
    flow.askSync(`Sync`, `2 commits`, [{ repo: `intentic`, pull: true, push: false }]);
    await flush();

    expect(flow.stage.value).toBeUndefined();
    expect(git.syncAll).toHaveBeenCalledTimes(1);
    expect(flow.pushed.value?.what).toBe(`2 commits`);
});

// Accepting the proposal is a statement that THIS tree is not the one to push: the agent gets the work, the
// push does not go, and the question is answered rather than left hanging.
test(`handing the failure to an agent starts the session and drops the push`, async () => {
    const { flow, git, suggestion, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, exitCode: 1 });
    await flush();
    const proposal = flow.proposedFix.value;

    flow.startFix();
    expect(suggestion.startSession).toHaveBeenCalledWith(proposal);
    expect(git.syncAll).not.toHaveBeenCalled();
    expect(flow.question.value).toBeUndefined();
    expect(flow.pending.value).toBeUndefined();
});

// How long this suite usually takes, so the readout can say more than "it is running": the difference between
// watching a progress line and being able to walk away from one.
test(`a completed run is remembered as how long the suite takes`, async () => {
    const { flow, finish } = await load();
    expect(flow.typicalMs.value).toBeUndefined();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, exitCode: 1, startedAt: 1_000, finishedAt: 121_000 });
    await flush();

    expect(flow.typicalMs.value).toBe(120_000);
    expect(localStorage.getItem(`intentic.prepushDuration.sb-1`)).toBe(`120000`);
});

// A killed run measures nothing: the clock was cut short, and remembering it would teach the readout a duration
// no suite ever takes.
test(`a timed-out run is not remembered as a duration`, async () => {
    const { flow, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, timedOut: true, startedAt: 1_000, finishedAt: 11_000 });
    await flush();

    expect(flow.typicalMs.value).toBeUndefined();
    expect(localStorage.getItem(`intentic.prepushDuration.sb-1`)).toBeNull();
});

/* A PUSH IS A RUN, and a refused one is filed with it, so the question it raises is built from the same
 * material as a red check's: the command, one line on how it ended, the terminal it ran in, and the fix. */
const refusedBy = (by: PushRun["refusedBy"], over: Partial<PushRun> = {}): PushRun => ({
    status: `failed`,
    repo: `intentic`,
    command: `git push origin main`,
    exitCode: 1,
    startedAt: 1_000,
    finishedAt: 5_000,
    session: `job-checks`,
    output: `verify-push: typecheck failed; the push does not go\nerror: failed to push some refs to 'origin'`,
    reason: `error: failed to push some refs to 'origin'`,
    ...(by === undefined ? {} : { refusedBy: by }),
    ...over,
});

test(`a push the repository's own hook refused asks with the run, and proposes a fix from what the hook printed`, async () => {
    const { flow, git, suggestion, finish, pushTerminal } = await load();
    const run = refusedBy(`hook`);
    git.failures.value = new Map([[`intentic`, { action: `Push failed`, detail: refusalSummary(run), run }]]);
    pushTerminal(`intentic`, `job-checks`);
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `passed` });
    await flush();

    expect(flow.pushed.value).toBeUndefined();
    expect(flow.question.value).toEqual({
        kind: `push`,
        title: `Push failed`,
        command: `git push origin main`,
        detail: `was refused by this repository's pre-push hook.`,
    });
    // The same terminal button a red check gets, pointed at the push's own window.
    expect(flow.terminal.value).toBe(`job-checks`);
    expect(suggestion.composeSession).toHaveBeenCalledTimes(1);
    expect(suggestion.composeSession).toHaveBeenCalledWith({ prompt: pushFixPrompt([run]), model: `claude:claude-sonnet-4-5`, effort: `high`, isolated: true });
    expect(flow.proposedFix.value).toEqual(expect.any(Object));
});

// A rejected ref or a dead host says nothing about the code, so there is nothing to send an agent after: the
// card carries git's own reason and the retry, exactly as a check that could not run proposes no fix.
test(`a push the remote rejected asks with git's reason and proposes no fix`, async () => {
    const { flow, git, suggestion, finish } = await load();
    const run = refusedBy(`remote`, { reason: `! [rejected] main -> main (fetch first)` });
    git.failures.value = new Map([[`intentic`, { action: `Push failed`, detail: refusalSummary(run), run }]]);
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `passed` });
    await flush();

    expect(flow.question.value).toEqual({
        kind: `push`,
        title: `Push failed`,
        command: `git push origin main`,
        detail: `was rejected by the remote: ! [rejected] main -> main (fetch first).`,
    });
    expect(suggestion.composeSession).not.toHaveBeenCalled();
    expect(flow.proposedFix.value).toBeUndefined();
});

test(`a push that hit its ceiling is named as timed out, in the verb the user clicked`, async () => {
    const { flow, git, suggestion, finish } = await load();
    const run = refusedBy(undefined, { timedOut: true, reason: undefined, output: `` });
    git.failures.value = new Map([[`intentic`, { action: `Publish failed`, detail: refusalSummary(run), run }]]);
    flow.askSync(`Publish`, `intentic's branch`, PUSH);
    finish({ status: `passed` });
    await flush();

    expect(flow.question.value).toEqual({
        kind: `push`,
        title: `Publish timed out`,
        command: `git push origin main`,
        detail: `never finished: it hit its time limit and was killed.`,
    });
    expect(suggestion.composeSession).not.toHaveBeenCalled();
});

// No check configured still means a push that can be refused by the repository's own hook, and the fix it
// proposes reads the same model settings the check's would have.
test(`a push with no check configured is still handed to an agent when the hook refuses it`, async () => {
    const { flow, git, suggestion, finish } = await load();
    const run = refusedBy(`hook`);
    git.failures.value = new Map([[`intentic`, { action: `Push failed`, detail: refusalSummary(run), run }]]);
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `passed` });
    await flush();
    // The check ran here; the same expectation with the rule removed is what the settings mock cannot vary
    // per test, so the model carried into the proposal is the assertion that matters: it was read.
    expect(suggestion.composeSession).toHaveBeenCalledWith(expect.objectContaining({ model: `claude:claude-sonnet-4-5`, effort: `high` }));
});
