import { type CommandRun, type PushRun, pushFixConversationId } from "@intentic/sandbox-contract";
import { beforeEach, expect, test, vi } from "vitest";
// oxlint-disable-next-line import/no-unassigned-import -- imported for its load cost alone, not for a binding
import "./usePushFlow";
import { checkOutcome, fixSignature, outcomeSummary, pushFixPrompt, refusalSummary } from "../health/fixProposal";

// No case here mounts a component: a push must finish, send, and raise its question even after the panel that
// started it is gone. Each mock owns its state, so `vi.resetModules` gives every case a clean flow and clean seams.

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
        // Vitest keeps a mock factory's result across `resetModules`, so this seam must be walked back by hand or a
        // case opens on the last one's verdict.
        reset: (): void => {
            run.value = { status: `idle`, command: `pnpm check`, output: `` };
            settle = undefined;
        },
    };
});

vi.mock(`../changes/useChanges`, async () => {
    const { ref } = await import(`vue`);
    // One of each, shared like the real module's singletons; a fresh spy per call would give the flow a different
    // `syncAll` than the one under assertion.
    const actionBusy = ref(false);
    const failures = ref(new Map<string, { action: string; detail: string }>());
    const syncAll = vi.fn(async () => {});
    return { COMMIT_SCOPE: `commit`, useChanges: () => ({ actionBusy, failures, syncAll }) };
});

// Push runs live behind useChanges (mocked above); this seam only tracks the terminal a refused push ran in,
// one per repo, like the daemon.
vi.mock(`./usePushRun`, async () => {
    const { computed } = await import(`vue`);
    const sessions = new Map<string, string>();
    return {
        usePushRun: (repo: string) => ({ terminal: computed(() => sessions.get(repo)), showTerminal: vi.fn() }),
        resetPushRuns: () => sessions.clear(),
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

// The flow gates on a `push.starting` rule, so this carries a real rule table, not a bare command field, and
// exercises the real reader (prepushCommandOf).
vi.mock(`../../sandbox/overview/useSandboxSettings`, async () => {
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
    // The pinned entry carries its own effort, so the tier the proposal names comes off the entry, not a shared
    // setting. Filed under `pre-push-fix`, this flow's own job.
    return {
        useSandboxSettings: () => ({
            settings: ref({ rules, modelRoles: { "pre-push-fix": [{ provider: `claude`, model: `claude-sonnet-4-5`, effort: `high` }] } }),
        }),
    };
});

// Resolves against what this sandbox can reach, so the proposal names a model that can actually be sent;
// provider readiness is a different suite's business.
vi.mock(`../../chat/session/access`, () => ({ providerReady: () => true }));

vi.mock(`../../sandbox/client/useSandbox`, async () => {
    const { ref } = await import(`vue`);
    return { useSandbox: () => ({ activeSandboxId: ref(`sb-1`) }) };
});

vi.mock(`../../agents/fleet/sessionSuggestion`, () => ({
    composeSession: vi.fn((draft: { prompt: string }) => ({
        draft,
        selectModel: vi.fn(),
        account: { value: undefined },
        harness: { value: undefined },
    })),
    startSession: vi.fn(),
}));

const PUSH = [{ repo: `intentic`, pull: false, push: true }];

const load = async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Sequential, and seams before the flow, not style: importing concurrently raced the factories into different
    // instances of their state, so warming the registry first keeps both sides the same.
    const prepush = await import(`./usePrepush`);
    const changes = await import(`../changes/useChanges`);
    const pushRuns = (await import(`./usePushRun`)) as unknown as { pushTerminal: (repo: string, session: string | undefined) => void; resetPushRuns: () => void };
    pushRuns.resetPushRuns();
    const suggestion = await import(`../../agents/fleet/sessionSuggestion`);
    const module = await import(`./usePushFlow`);
    const seam = prepush as unknown as { finish: (fields: Partial<CommandRun>) => void; reset: () => void };
    seam.reset();
    // The flow captures useChanges on its first call; singletons carry over from the last case.
    const git = changes.useChanges();
    git.actionBusy.value = false;
    git.failures.value = new Map();
    return { finish: seam.finish, git, suggestion, pushTerminal: pushRuns.pushTerminal, flow: module.usePushFlow() };
};

// The seams resolve immediately, so a macrotask boundary drains however many microtasks a path takes, rather
// than counting ticks that shift with the code.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// This suite runs on `node`, with no storage; the remembered duration is the only thing that touches it, so
// it gets a minimal stand-in instead of jsdom.
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
    // The only thing a success says, and it says it where the click was.
    expect(flow.pushed.value?.what).toBe(`3 commits`);
});

// The case the rewrite is for: a verdict lands on a flow whose panel is long gone, and a second caller
// (notice, rail) sees the same question, not a fresh empty one.
test(`a red check raises a question that outlives the surface that asked`, async () => {
    const { flow, git, suggestion, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, exitCode: 1, output: `2 tests failed` });
    await flush();

    expect(git.syncAll).not.toHaveBeenCalled();
    const settled: CommandRun = { status: `failed`, command: `pnpm check`, output: `2 tests failed`, exitCode: 1 };
    expect(flow.question.value).toMatchObject({ kind: `checks`, command: settled.command, detail: outcomeSummary(settled) });
    expect(flow.question.value?.title).not.toBe(checkOutcome({ ...settled, status: `cancelled` }));
    // Model is resolved from the sandbox's live list, not copied from settings, since a gone account can't run.
    expect(suggestion.composeSession).toHaveBeenCalledTimes(1);
    expect(suggestion.composeSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: `claude:claude-sonnet-4-5`, effort: `high`, isolated: true }),
    );
    expect(flow.proposedFix.value).toEqual(expect.any(Object));

    const { usePushFlow } = await import(`./usePushFlow`);
    expect(usePushFlow().question.value).toEqual(flow.question.value);
});

// Push anyway never asks twice; the verdict it outran has nobody left to interrupt.
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

// Stopping the suite doesn't abandon the push: the decision is still open, but no fix is proposed for a run
// that never got to find anything.
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

// A command that couldn't run says nothing about the code, so there's nothing to send an agent after.
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

// "Did my push go" is the real question; a refused send must answer it as loudly as a refused check, or work
// on disk reads as sent.
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

// Keeping working while the suite runs is exactly what breaks a blind push: useChanges refuses a second batch
// while one's in flight, so a check landing mid-commit must wait, not drop.
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

// A pull-only sync sends nothing, so there's no check to run, but the outcome is still reported either way.
test(`a pull-only sync skips the check entirely`, async () => {
    const { flow, git } = await load();
    flow.askSync(`Sync`, `2 commits`, [{ repo: `intentic`, pull: true, push: false }]);
    await flush();

    expect(flow.stage.value).toBeUndefined();
    expect(git.syncAll).toHaveBeenCalledTimes(1);
    expect(flow.pushed.value?.what).toBe(`2 commits`);
});

// Accepting the proposal hands the tree to the agent instead of pushing, answering the question rather than
// leaving it open.
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

test(`starting a fix with a picked model re-points the session before starting`, async () => {
    const { flow, suggestion, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, exitCode: 1 });
    await flush();
    const proposal = flow.proposedFix.value as unknown as { selectModel: ReturnType<typeof vi.fn> };

    flow.startFix({ provider: `cursor`, model: `composer-2.5`, label: `Composer 2.5` });
    expect(proposal.selectModel).toHaveBeenCalledWith({ provider: `cursor`, value: `composer-2.5` });
    expect(suggestion.startSession).toHaveBeenCalledWith(proposal);
    expect(flow.question.value).toBeUndefined();
    expect(flow.pending.value).toBeUndefined();
});

// How long this suite usually takes, so the readout can say more than "it is running".
test(`a completed run is remembered as how long the suite takes`, async () => {
    const { flow, finish } = await load();
    expect(flow.typicalMs.value).toBeUndefined();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, exitCode: 1, startedAt: 1_000, finishedAt: 121_000 });
    await flush();

    expect(flow.typicalMs.value).toBe(120_000);
    expect(localStorage.getItem(`intentic.prepushDuration.sb-1`)).toBe(`120000`);
});

// A killed run measures nothing; remembering its cut-short clock would teach the readout a duration no suite takes.
test(`a timed-out run is not remembered as a duration`, async () => {
    const { flow, finish } = await load();
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `failed`, timedOut: true, startedAt: 1_000, finishedAt: 11_000 });
    await flush();

    expect(flow.typicalMs.value).toBeUndefined();
    expect(localStorage.getItem(`intentic.prepushDuration.sb-1`)).toBeNull();
});

// A push is a run, and a refused one is filed with it: the question is built from the same material as a red
// check's (command, one line on how it ended, the terminal, the fix).
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
    expect(suggestion.composeSession).toHaveBeenCalledWith({
        prompt: pushFixPrompt([run]),
        model: `claude:claude-sonnet-4-5`,
        effort: `high`,
        isolated: true,
        // Derived the same way the flow derives it, not transcribed, since spelling a name twice invites drift.
        conversationId: pushFixConversationId(run.repo, fixSignature(run.output)),
    });
    expect(flow.proposedFix.value).toEqual(expect.any(Object));
});

// One broken tree raises this question on every press of Push; the id derived from the failure lets a second
// press continue the same agent instead of minting a new one.
test(`two runs of the same failure propose the same conversation, and a different failure does not`, async () => {
    // Read back before the next `load()`: the suggestion module's mock survives `resetModules`, so a call read
    // after the next load would wear that load's name.
    const proposedFor = async (output: string): Promise<string | undefined> => {
        const { flow, finish, suggestion } = await load();
        flow.askSync(`Push`, `3 commits`, PUSH);
        finish({ status: `failed`, output });
        await flush();
        return vi.mocked(suggestion.composeSession).mock.calls.at(-1)?.[0].conversationId;
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

// No check configured still leaves a push the hook can refuse, and the fix reads the same model settings a
// check's would.
test(`a push with no check configured is still handed to an agent when the hook refuses it`, async () => {
    const { flow, git, suggestion, finish } = await load();
    const run = refusedBy(`hook`);
    git.failures.value = new Map([[`intentic`, { action: `Push failed`, detail: refusalSummary(run), run }]]);
    flow.askSync(`Push`, `3 commits`, PUSH);
    finish({ status: `passed` });
    await flush();
    // The rule is removed here since the mock can't vary per test; the model reaching the proposal is the assertion.
    expect(suggestion.composeSession).toHaveBeenCalledWith(expect.objectContaining({ model: `claude:claude-sonnet-4-5`, effort: `high` }));
});
