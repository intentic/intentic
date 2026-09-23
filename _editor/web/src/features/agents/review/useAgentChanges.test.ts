import { mocked } from "@intentic/testing/bun";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

const stub = {
    // The app's one self-retiring receipt lane, so a test can tell an outcome from a failure by which channel it took.
    said: [] as string[],
    // The shared sentence both land presses take, held here so a test proves this one passes it through rather than
    // inventing its own wording.
    nothingLanded: `Nothing to land: this conversation's branch holds no work your workspace doesn't already have.`,
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
jest.mock("../../../shell/notifications/notifications", () => ({
    useNotifications: () => ({ say: (message: string) => stub.said.push(message) }),
}));
jest.mock("../../../lib/queryPersistence", () => ({ queryClient: { fetchQuery: jest.fn() }, UNPERSISTED: `unpersisted` }));
jest.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc() }));
jest.mock("../../sandbox/client/useSandboxQuery", () => ({
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
// declined mutation, so it takes the floating receipt rather than the panel's red error line.
it("says so when a land carried nothing, and stays quiet when it carried work", async () => {
    const changes = useAgentChanges(ref(`c1`));

    mocked(landAgent).mockResolvedValue({ landed: true, changed: true });
    await changes.land();
    expect(stub.said).toEqual([]);

    mocked(landAgent).mockResolvedValue({ landed: true, changed: false });
    await changes.land();
    expect(stub.said).toEqual([stub.nothingLanded]);
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
