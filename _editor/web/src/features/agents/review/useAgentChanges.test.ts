import { STATE_DIR } from "@intentic/constants";
import { mocked } from "@intentic/testing/bun";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

const stub = {
    // The app's one self-retiring receipt lane, so a test can tell an outcome from a failure by which channel it took.
    said: [] as string[],
    // The shared sentence both land presses take, held here so a test proves this one passes it through rather than
    // inventing its own wording.
    nothingLanded: `Nothing to land: this conversation's branch holds no work your workspace doesn't already have.`,
    // What the review asked the daemon to commit, in order.
    commits: new Array<unknown>(),
    // What the root repo's index already holds when a press reads it.
    staged: new Array<string>(),
};

jest.mock("@intentic/ui/async", () => ({
    useAsyncAction: () => ({
        busy: { value: false },
        notice: { value: undefined },
        // Runs the task rather than swallowing it, as the real one does: what `land` makes of the daemon's answer is
        // the whole question below.
        run: (task: () => Promise<void>) => task(),
    }),
}));
jest.mock("../../../workbench/notifications/notifications", () => ({
    useNotifications: () => ({ say: (message: string) => stub.said.push(message) }),
}));
jest.mock("../../../lib/queryPersistence", () => ({ queryClient: { fetchQuery: jest.fn() }, UNPERSISTED: `unpersisted` }));
jest.mock("../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        git: {
            changes: async () => ({
                repos: [
                    {
                        repo: `root`,
                        conflicted: [],
                        staged: stub.staged.map((path) => ({ path, status: `modified` as const, additions: 1, deletions: 0 })),
                        unstaged: [],
                    },
                ],
            }),
            commit: async (input) => {
                stub.commits.push(input);
                return { committed: true };
            },
        },
    }),
}));
jest.mock("../../../client/sandbox/useSandboxQuery", () => ({
    useSandboxQuery: () => ({
        query: {
            data: { value: undefined },
            isFetching: { value: false },
            refetch: jest.fn(),
        },
        error: { value: undefined },
    }),
}));
jest.mock("../fleet/agentActions", () => ({
    askAgentToResolve: jest.fn(),
    discardAgent: jest.fn(),
    invalidateAgentAction: jest.fn(async () => undefined),
    landAgent: jest.fn(),
    nothingLanded: () => stub.nothingLanded,
}));
// `agentById` answers from the card each case puts on the board: whether that card is in a turn is what an ask lives as
// long as. Read at call time, so the map below is in place by then.
jest.mock("../fleet/useAgents", () => ({
    useAgents: () => ({ archive: jest.fn(), setAutoLand: jest.fn(), agentById: (id: string) => cards.value.get(id) }),
}));

import { nextTick, ref, shallowRef } from "vue";
import { askAgentToResolve, landAgent, type ResolveAsk } from "../fleet/agentActions";
import type { FleetAgent } from "../fleet/useAgents-fleet";
import { useAgentChanges } from "./useAgentChanges";

const cards = shallowRef<ReadonlyMap<string, Pick<FleetAgent, "status" | "attention">>>(new Map());
const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };

afterEach(() => {
    stub.said.length = 0;
    stub.commits.length = 0;
    stub.staged.length = 0;
    cards.value = new Map();
});

it("isolates viewed files when agent ids name object prototype properties", () => {
    const prototype = useAgentChanges(ref(`__proto__`));
    const constructor = useAgentChanges(ref(`constructor`));

    prototype.setViewed([`root/src/prototype.ts`], true);
    expect([...prototype.viewed.value]).toEqual([`root/src/prototype.ts`]);
    expect([...constructor.viewed.value]).toEqual([]);

    constructor.setViewed([`root/src/constructor.ts`], true);
    prototype.setViewed([`root/src/prototype.ts`], false);

    expect([...prototype.viewed.value]).toEqual([]);
    expect([...constructor.viewed.value]).toEqual([`root/src/constructor.ts`]);
});

// Merged-and-nothing-moved is the one land outcome the review cannot show for itself: its rows are read off the branch
// and do not move, so an unsaid one leaves the press looking exactly like one that worked. It is an outcome, not a
// declined mutation, so it takes the floating receipt rather than the panel's error line.
it("says so when a land carried nothing, and stays quiet when it carried work", async () => {
    const changes = useAgentChanges(ref(`c1`));

    mocked(landAgent).mockResolvedValue({ landed: true, changed: true });
    await changes.land();
    expect(stub.said).toEqual([]);

    mocked(landAgent).mockResolvedValue({ landed: true, changed: false });
    await changes.land();
    expect(stub.said).toEqual([stub.nothingLanded]);
});

// A refusal held by files a Sandbox page wrote (AgentConflictReport's one press): exactly those are committed first, in
// the same press as the land; every other land commits nothing.
it("commits the settings files a refusal held before landing again, and nothing on an ordinary land", async () => {
    const changes = useAgentChanges(ref(`c1`));
    mocked(landAgent).mockClear();
    mocked(landAgent).mockResolvedValue({ landed: true, changed: true });

    await changes.land(`check`, undefined, false, [`${STATE_DIR}/config/personas.json`]);
    expect(stub.commits).toEqual([{ repo: `root`, message: `Settings: saved before landing`, stage: { paths: [`.intentic/config/personas.json`] } }]);
    expect(mocked(landAgent)).toHaveBeenCalledTimes(1);

    await changes.land();
    expect(stub.commits).toHaveLength(1);
    expect(mocked(landAgent)).toHaveBeenCalledTimes(2);
});

// Landed work that left the workspace goes back with the next land, unless an agent took it out on purpose: then a plain
// land carries only the new work, and putting the rest back is the explicit Land again (cumulative).
it("re-lands work taken out after landing, but not work an agent took out on purpose", async () => {
    mocked(landAgent).mockClear();
    mocked(landAgent).mockResolvedValue({ landed: true, changed: true });
    const gone = ref({ landedPresence: { landed: 3, present: 0 } });
    const taken = ref({ landedPresence: { landed: 3, present: 0, removedBy: { kind: `agent` as const, id: `tidy-1` } } });

    await useAgentChanges(ref(`gone`), undefined, gone).land();
    await useAgentChanges(ref(`taken`), undefined, taken).land();
    await useAgentChanges(ref(`taken`), undefined, taken).land(`check`, `cumulative`);
    expect(mocked(landAgent).mock.calls.map((call) => call[2])).toEqual([`cumulative`, `outstanding`, `cumulative`]);
});

// The commit takes the whole index, so the owner's own staged work would ride along under "Settings: saved before
// landing": the press stops before staging anything and says why, and the land does not run.
it("refuses to save the settings files while other work is staged, and lands nothing", async () => {
    const changes = useAgentChanges(ref(`c1`));
    mocked(landAgent).mockClear();
    stub.staged.push(`${STATE_DIR}/config/personas.json`, `src/app.ts`);

    await expect(changes.land(`check`, undefined, false, [`.intentic/config/personas.json`])).rejects.toThrow(`1 other change staged`);
    expect(stub.commits).toEqual([]);
    expect(mocked(landAgent)).not.toHaveBeenCalled();
});

// The ask is the review's "the agent is on it" line, and it has to show on the press: the turn it starts is drawn at
// once (useAgents-provisional), and a panel still offering the ladder beside a card already in Active reads as two
// answers to one question. It lives exactly as long as that turn, however often the report is re-read under it.
it("marks the ask on the press and keeps it for the turn it started, then lets it go with that turn", async () => {
    const changes = useAgentChanges(ref(`asked-1`));
    let answer: (ask: ResolveAsk) => void = () => undefined;
    mocked(askAgentToResolve).mockImplementation(() => new Promise((settle) => (answer = settle)));

    const press = changes.askResolve();
    expect(changes.asked.value).toBe(true);

    cards.value = new Map([[`asked-1`, { status: `running`, attention: none }]]);
    await nextTick();
    answer({ kind: `sent` });
    await press;
    expect(changes.asked.value).toBe(true);

    cards.value = new Map([[`asked-1`, { status: `conflict`, attention: { ...none, conflict: true } }]]);
    await nextTick();
    expect(changes.asked.value).toBe(false);
});

it("drops the ask the moment the press turns out to have started no turn", async () => {
    const refused = useAgentChanges(ref(`asked-2`));
    mocked(askAgentToResolve).mockResolvedValue({ kind: `refused`, why: `A rebase can't reach this.` });
    await expect(refused.askResolve()).rejects.toThrow(`A rebase can't reach this.`);
    expect(refused.asked.value).toBe(false);

    // Good news is not an ask either, and takes the floating receipt rather than the panel's error line.
    const repaired = useAgentChanges(ref(`asked-3`));
    mocked(askAgentToResolve).mockResolvedValue({ kind: `settled`, why: `Nothing is blocking this any more: it's ready to land.` });
    await repaired.askResolve();
    expect(repaired.asked.value).toBe(false);
    expect(stub.said).toEqual([`Nothing is blocking this any more: it's ready to land.`]);
});

// A fix pressed while a turn runs used to be a disabled button with the reason in a tooltip. Now it waits: nothing is
// said into the running turn, and the ask goes the moment that turn ends, unless it was taken back first.
it("queues a fix pressed mid-turn and asks once the turn ends", async () => {
    cards.value = new Map([[`queued-1`, { status: `running`, attention: none }]]);
    const changes = useAgentChanges(ref(`queued-1`));
    mocked(askAgentToResolve).mockClear();
    mocked(askAgentToResolve).mockResolvedValue({ kind: `sent` });
    await nextTick();

    await changes.fixConflicts();
    expect(changes.fixQueued.value).toBe(true);
    expect(askAgentToResolve).not.toHaveBeenCalled();

    cards.value = new Map([[`queued-1`, { status: `conflict`, attention: { ...none, conflict: true } }]]);
    await nextTick();
    await nextTick();
    expect(changes.fixQueued.value).toBe(false);
    expect(askAgentToResolve).toHaveBeenCalledTimes(1);
});

it("drops a queued fix that was cancelled before the turn ended", async () => {
    cards.value = new Map([[`queued-2`, { status: `running`, attention: none }]]);
    const changes = useAgentChanges(ref(`queued-2`));
    mocked(askAgentToResolve).mockClear();
    await nextTick();

    await changes.fixConflicts();
    changes.cancelFix();
    expect(changes.fixQueued.value).toBe(false);

    cards.value = new Map([[`queued-2`, { status: `conflict`, attention: { ...none, conflict: true } }]]);
    await nextTick();
    await nextTick();
    expect(askAgentToResolve).not.toHaveBeenCalled();
});

// With no turn running there is nothing to wait for: the press is the ask.
it("asks at once when no turn is running", async () => {
    cards.value = new Map([[`queued-3`, { status: `conflict`, attention: { ...none, conflict: true } }]]);
    const changes = useAgentChanges(ref(`queued-3`));
    mocked(askAgentToResolve).mockClear();
    mocked(askAgentToResolve).mockResolvedValue({ kind: `sent` });
    await nextTick();

    await changes.fixConflicts();
    expect(changes.fixQueued.value).toBe(false);
    expect(askAgentToResolve).toHaveBeenCalledTimes(1);
});
