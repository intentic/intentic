import type { FleetAgent } from "../../../agents/fleet/useAgents-fleet";
import { landsOf, waitTargets } from "./waitTargets";

// Which agents a message can wait for: this sandbox's live ones with something still to land, newest work first, never
// itself and never a spawned child (whose work lands into its parent). And how each one's work reaches the workspace.

const NONE = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const agent = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    status: `running`,
    provider: `claude`,
    harness: `native`,
    branch: `agent/${id}`,
    updatedAt: 1,
    attention: NONE,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});

const ids = (agents: readonly FleetAgent[], self = `self`): string[] => waitTargets(agents, self, false).map(({ agent: target }) => target.id);

describe(`the agents a message can wait for`, () => {
    it(`lists what still has work to land, under way first, then waiting on a press, then the rest, each newest first`, () => {
        const fleet = [
            agent(`ready-old`, { status: `ready`, updatedAt: 1 }),
            agent(`running`, { status: `running`, updatedAt: 2 }),
            agent(`stopped`, { status: `stopped`, updatedAt: 9 }),
            agent(`conflict`, { status: `conflict`, updatedAt: 5 }),
            agent(`asking`, { status: `awaiting`, updatedAt: 3 }),
        ];
        expect(ids(fleet)).toEqual([`asking`, `running`, `conflict`, `ready-old`, `stopped`]);
    });

    it(`leaves out what has nothing left to come: landed or idle with nothing waiting`, () => {
        const scheduled = { items: [{ id: `m1`, text: `next`, voice: `person` as const, queuedAt: 1, revision: 1 }], revision: 1, paused: `scheduled` as const };
        const fleet = [agent(`landed`, { status: `landed` }), agent(`idle`, { status: `idle` }), agent(`booked`, { status: `idle`, queue: scheduled })];
        expect(ids(fleet)).toEqual([`booked`]);
    });

    it(`never lists itself, a spawned child, another sandbox's, an archived one, one waiting for it, or one the daemon has no record of`, () => {
        const waitsForSelf = { items: [{ id: `m1`, text: `after`, voice: `person` as const, queuedAt: 1, revision: 1 }], revision: 1, paused: `scheduled` as const, after: `self` };
        // Each message carries its own booking: one waiting for `self` behind a sooner time, where the queue's own field
        // names only that time.
        const behindATime = {
            items: [
                { id: `m1`, text: `first`, voice: `person` as const, queuedAt: 1, revision: 1, until: 9_000 },
                { id: `m2`, text: `after`, voice: `person` as const, queuedAt: 1, revision: 2, after: `self` },
            ],
            revision: 2,
            paused: `scheduled` as const,
            until: 9_000,
        };
        const fleet = [
            agent(`self`),
            agent(`circular`, { status: `idle`, queue: waitsForSelf }),
            agent(`circular-later`, { status: `idle`, queue: behindATime }),
            agent(`child`, { startedBy: `agent:parent-id` }),
            agent(`elsewhere`, { sandboxId: `box-2` }),
            agent(`archived`, { archivedAt: 5 }),
            agent(`draft`, { status: `draft` }),
            agent(`kept`),
        ];
        expect(ids(fleet)).toEqual([`kept`]);
    });
});

describe(`how an agent's work reaches the workspace`, () => {
    it(`lands by itself, waits for the reader's land, or is there as it goes in the shared tree`, () => {
        expect(landsOf({ branch: `agent/a`, autoLand: true }, false)).toBe(`itself`);
        expect(landsOf({ branch: `agent/a` }, true)).toBe(`itself`);
        expect(landsOf({ branch: `agent/a` }, false)).toBe(`you`);
        expect(landsOf({ branch: `agent/a`, autoLand: false }, true)).toBe(`you`);
        expect(landsOf({ branch: undefined }, true)).toBe(`workspace`);
    });
});
