// The order Next Chat That Needs You walks: what waits on the reader first, then news not read yet, oldest first (tabs.ts).
import { NO_ATTENTION } from "../../../../models/agent-status/agentStatus-lanes";
import type { FleetAgent } from "../../../../models/fleet/useAgents-fleet";
import { needsYouQueue } from "../tabs";

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `idle`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const asking = (id: string, updatedAt: number): FleetAgent => card(id, { status: `awaiting`, updatedAt });
const news = (id: string, updatedAt: number): FleetAgent => card(id, { unread: true, updatedAt });
const ids = (agents: readonly FleetAgent[]): string[] => agents.map((agent) => agent.id);

test(`walks what waits on the reader, newest first, then unread news, oldest first`, () => {
    const fleet = [news(`late-news`, 900), asking(`old-question`, 100), news(`early-news`, 300), asking(`new-question`, 500), card(`read`)];
    expect(ids(needsYouQueue(fleet))).toEqual([`new-question`, `old-question`, `early-news`, `late-news`]);
});

test(`leaves out what is still working, a workflow step, and another sandbox's agent`, () => {
    const fleet = [
        card(`working`, { status: `running`, unread: true }),
        // SAFETY: needsYouQueue reads only whether a step belongs to a run, never the run's facts.
        card(`step`, { unread: true, workflow: { runId: `r1` } as FleetAgent["workflow"] }),
        card(`elsewhere`, { unread: true, sandboxId: `other` }),
        news(`mine`, 200),
    ];
    expect(ids(needsYouQueue(fleet))).toEqual([`mine`]);
});
