import { afterEach, expect, it, vi } from "vitest";

const stub = vi.hoisted(() => ({
    // The app's one self-retiring receipt lane, so a test can tell an outcome from a failure by which channel it took.
    said: [] as string[],
    // The shared sentence both land presses take, held here so a test proves this one passes it through rather than
    // inventing its own wording.
    nothingLanded: `Nothing to land: this conversation's branch holds no work your workspace doesn't already have.`,
}));

vi.mock("@intentic/ui/async", () => ({
    useAsyncAction: () => ({
        busy: { value: false },
        notice: { value: undefined },
        // Runs the task rather than swallowing it, as the real one does: what `land` makes of the daemon's answer is
        // the whole question below.
        run: (task: () => Promise<void>) => task(),
    }),
}));
vi.mock("../../../shell/notifications/notifications", () => ({
    useNotifications: () => ({ say: (message: string) => stub.said.push(message) }),
}));
vi.mock("../../../lib/queryPersistence", () => ({ queryClient: { fetchQuery: vi.fn() }, UNPERSISTED: `unpersisted` }));
vi.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJson: vi.fn() }));
vi.mock("../../sandbox/client/useSandboxQuery", () => ({
    useSandboxQuery: () => ({
        query: {
            data: { value: undefined },
            isFetching: { value: false },
            refetch: vi.fn(),
        },
        error: { value: undefined },
    }),
}));
vi.mock("../fleet/agentActions", () => ({
    askAgentToResolve: vi.fn(),
    discardAgent: vi.fn(),
    invalidateAgentAction: vi.fn(async () => undefined),
    landAgent: vi.fn(),
    NOTHING_LANDED: stub.nothingLanded,
}));
vi.mock("../fleet/useAgents", () => ({ useAgents: () => ({ archive: vi.fn(), setAutoLand: vi.fn() }) }));

import { ref } from "vue";
import { landAgent } from "../fleet/agentActions";
import { useAgentChanges } from "./useAgentChanges";

afterEach(() => {
    stub.said.length = 0;
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

    vi.mocked(landAgent).mockResolvedValue({ landed: true, changed: true });
    await changes.land();
    expect(stub.said).toEqual([]);

    vi.mocked(landAgent).mockResolvedValue({ landed: true, changed: false });
    await changes.land();
    expect(stub.said).toEqual([stub.nothingLanded]);
});
