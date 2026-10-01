import { NO_ATTENTION } from "../../../agents/fleet/agentStatus";
import type { FleetAgent } from "../../../agents/fleet/useAgents-fleet";
import { forksAt } from "../forksIndex";

const fork = (id: string, conversationId: string, index: number): FleetAgent => ({
    id,
    title: `fork ${id}`,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 0,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    forkedFrom: { conversationId, index, files: `now` },
});

it(`answers each cut's forks from one index per roster, and the same empty answer where none was taken`, () => {
    const fleet = [fork(`f1`, `c1`, 3), fork(`f2`, `c1`, 3), fork(`f3`, `c1`, 7), fork(`f4`, `c2`, 3)];

    expect(forksAt(fleet, `c1`, 3).map((agent) => agent.id)).toEqual([`f1`, `f2`]);
    expect(forksAt(fleet, `c1`, 7).map((agent) => agent.id)).toEqual([`f3`]);
    expect(forksAt(fleet, `c2`, 3).map((agent) => agent.id)).toEqual([`f4`]);
    expect(forksAt(fleet, `c1`, 4)).toBe(forksAt([...fleet], `c9`, 0));
});
