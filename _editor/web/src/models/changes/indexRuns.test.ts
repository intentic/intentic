import type { IndexRun, IndexRunStart } from "@intentic/sandbox-contract/schemas/git/index-run";
import { fakeSandboxRpc } from "../../testing/sandboxRpcFake";

// Following a stage or commit run to its verdict: the guardrail's question and both answers to it, each way a run can end
// short of passing, a reconnect mid-run, and the slow-run event. The daemon is a script of states.

const track = jest.fn();
jest.mock("../../app/analytics", () => ({ track }));

// Which routes the daemon advertises (useDaemonRoutes): all of them unless a test says otherwise.
let served = (_route: string): boolean => true;
jest.mock("../../client/sandbox/useDaemonRoutes", () => ({ supportsRoute: (route: string) => served(route) }));

const starts: Omit<IndexRunStart, `repo`>[] = [];
// The one-request calls a daemon from before the runs answers instead.
const oneShots: unknown[] = [];
let script: (IndexRun | `throw`)[] = [];
const cancels: string[] = [];
const rpc = fakeSandboxRpc({
    git: {
        indexRunStart: async ({ repo, ...request }) => {
            starts.push(request);
            return { status: `running`, id: `run-${String(starts.length)}`, repo, op: request.op, phase: `waiting`, command: `git`, output: `` };
        },
        indexRunState: async () => {
            const next = script.shift() ?? `throw`;
            if (next === `throw`) {
                throw new Error(`tunnel dropped`);
            }
            return next;
        },
        indexRunCancel: async ({ repo }) => {
            cancels.push(repo);
            return { ok: true };
        },
        commit: async (input) => {
            oneShots.push({ commit: input });
            return { committed: true };
        },
        stage: async (input) => {
            oneShots.push({ stage: input });
            return { ok: true };
        },
    },
});
jest.mock("../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: rpc }));

const { cancelIndexRun, followedRuns, holdQuestions, runIndexJob, SLOW_GIT_OP_MS } = await import("./indexRuns");

// A settled state for the nth start, spanning `ms` on the daemon's clock.
const settled = (n: number, over: Partial<IndexRun> = {}, ms = 1_000): IndexRun => ({
    status: `passed`,
    id: `run-${String(n)}`,
    repo: `app`,
    op: `commit`,
    command: `git commit`,
    output: ``,
    startedAt: 10_000,
    finishedAt: 10_000 + ms,
    files: { total: 3, done: 3 },
    ...over,
});

beforeEach(() => {
    served = () => true;
    oneShots.length = 0;
    starts.length = 0;
    cancels.length = 0;
    script = [];
    track.mockClear();
    holdQuestions.value = [];
});

test("a run that passes resolves with its verdict, and leaves nothing drawn behind it", async () => {
    script = [settled(1, { result: { committed: true } })];
    const run = await runIndexJob(`app`, { op: `commit`, message: `feat: x`, target: {} });
    expect(run.result).toEqual({ committed: true });
    expect(starts).toEqual([{ op: `commit`, message: `feat: x`, target: {} }]);
    expect(followedRuns.value.size).toBe(0);
    expect(track).not.toHaveBeenCalled();
});

test("a run held at the guardrail asks, and a yes starts it again past the guardrail", async () => {
    const hold = { files: 53_000, dirs: [{ dir: `venv`, files: 52_990 }] };
    script = [settled(1, { status: `error`, held: hold }), settled(2, { op: `stage` })];
    const pending = runIndexJob(`app`, { op: `stage`, target: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(holdQuestions.value).toHaveLength(1);
    const asked = holdQuestions.value[0]!;
    expect([asked.repo, asked.op, asked.hold.files, asked.hold.dirs[0]?.dir]).toEqual([`app`, `stage`, 53_000, `venv`]);
    holdQuestions.value[0]!.answer(true);
    expect((await pending).id).toBe(`run-2`);
    expect(starts).toEqual([
        { op: `stage`, target: {} },
        { op: `stage`, target: {}, confirmed: true },
    ]);
    expect(holdQuestions.value).toEqual([]);
});

test("a no at the guardrail stages nothing and says so, as the batch files any failure", async () => {
    script = [settled(1, { status: `error`, held: { files: 2_500, dirs: [] } })];
    const pending = runIndexJob(`app`, { op: `commit`, message: `feat: x`, target: {} });
    await new Promise((resolve) => setTimeout(resolve, 10));
    holdQuestions.value[0]!.answer(false);
    await expect(pending).rejects.toThrow(/2,500|2500|2 500/);
    expect(starts).toHaveLength(1);
});

test("a stopped run and a refused one both throw, the refusal in git's own words", async () => {
    script = [settled(1, { status: `cancelled` })];
    await expect(runIndexJob(`app`, { op: `stage` })).rejects.toThrow();
    script = [settled(2, { status: `failed`, reason: `pre-commit hook refused` })];
    await expect(runIndexJob(`app`, { op: `commit`, message: `feat: x` })).rejects.toThrow(`pre-commit hook refused`);
});

test("a dropped poll is a reconnect, not a verdict: following goes on, and the line says it lost contact meanwhile", async () => {
    script = [`throw`, settled(1)];
    const pending = runIndexJob(`app`, { op: `commit`, message: `feat: x` });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(followedRuns.value.get(`app`)?.lostContact).toBe(true);
    expect((await pending).status).toBe(`passed`);
});

test("a run the daemon no longer knows (a restart) is reported lost, not read as some other run's verdict", async () => {
    script = [{ status: `idle`, id: ``, repo: `app`, command: ``, output: `` }];
    await expect(runIndexJob(`app`, { op: `stage` })).rejects.toThrow();
});

test("a run past the slow line sends git_op_slow with its op, files and duration; Stop reaches the daemon", async () => {
    script = [settled(1, { op: `stage`, files: { total: 53_000, done: 53_000 } }, SLOW_GIT_OP_MS + 5_000)];
    await runIndexJob(`app`, { op: `stage` });
    expect(track).toHaveBeenCalledWith(`git_op_slow`, { op: `stage`, files: 53_000, ms: SLOW_GIT_OP_MS + 5_000 });
    await cancelIndexRun(`app`);
    expect(cancels).toEqual([`app`]);
});

// A self-hosted sandbox updates on its own schedule, so this page often talks to a daemon from before the runs: there a
// commit or a stage-all goes through the one-request routes it always did, rather than failing on a route it lacks.
test("a daemon without the runs commits and stages through its one-request routes", async () => {
    served = (route) => route !== `git.indexRunStart`;
    const committed = await runIndexJob(`app`, { op: `commit`, message: `feat: x`, target: {} });
    const recorded = await runIndexJob(`app`, { op: `commit`, message: `fix: y` });
    const staged = await runIndexJob(`app`, { op: `stage`, target: { scope: { origin: `brave-otter` } } });

    expect([committed.status, committed.result, recorded.result, staged.status]).toEqual([`passed`, { committed: true }, { committed: true }, `passed`]);
    expect(oneShots).toEqual([
        { commit: { repo: `app`, message: `feat: x`, stage: {} } },
        { commit: { repo: `app`, message: `fix: y` } },
        { stage: { repo: `app`, scope: { origin: `brave-otter` } } },
    ]);
    expect(starts).toEqual([]);
});
