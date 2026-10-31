import { ref } from "vue";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";

const sandboxes = ref<{ id: string; name: string; image: string | null; lastSeenAt: string | null }[]>([]);
const activeSandboxId = ref<string | undefined>(`sbx-here`);
const select = jest.fn();
jest.mock("../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId, select }) }));

// The store this reads from, stubbed to the shape its surfaces see; what it does with the network is fleetAcross's own
// business.
const otherBoxes = ref<unknown[]>([]);
jest.mock("../sandbox/live/fleetAcross", () => ({
    otherBoxes,
    subscribe: jest.fn(),
    refreshAcross: jest.fn(),
    markSeenAcross: jest.fn(),
}));

const landOnAfterSwitch = jest.fn();
jest.mock("../sandbox/sandboxScreen", () => ({ landOnAfterSwitch }));

const { boxNameOf, isRemote, openInSandbox, otherFleet, sandboxesElsewhere } = await import("./fleetScope");
const { claim } = await import("./useAgents-provisional");

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const agent = (over: Partial<AgentSummary>): AgentSummary =>
    ({ id: `a1`, status: `idle`, provider: `claude`, harness: `claude-code`, updatedAt: 1, attention: none, ...over }) as AgentSummary;

const boxOf = (id: string, name: string, agents: AgentSummary[]): unknown => ({
    sandbox: { id, name, image: null },
    state: `ready`,
    agents,
    held: [],
    readAt: 1,
});

beforeEach(() => {
    otherBoxes.value = [];
    activeSandboxId.value = `sbx-here`;
    sandboxes.value = [
        { id: `sbx-here`, name: `Guest`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` },
        { id: `sbx-laptop`, name: `Laptop`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` },
    ];
    select.mockClear();
    landOnAfterSwitch.mockClear();
});

describe("whether there is another sandbox to place a conversation in", () => {
    it("says no on an account with a single sandbox", () => {
        sandboxes.value = [{ id: `sbx-here`, name: `Guest`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` }];
        expect(sandboxesElsewhere.value).toBe(false);
    });

    // A sandbox that never checked in has no daemon to read, so it isn't somewhere else to look.
    it("does not count an unfinished setup as somewhere else to look", () => {
        sandboxes.value = [
            { id: `sbx-here`, name: `Guest`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` },
            { id: `sbx-half`, name: `Half`, image: null, lastSeenAt: null },
        ];
        expect(sandboxesElsewhere.value).toBe(false);
    });

    it("says yes once a second sandbox has checked in", () => {
        expect(sandboxesElsewhere.value).toBe(true);
    });
});

describe("another box's agents in card shape", () => {
    // `open` and `unsent` are facts about a tab in this browser pointed at this daemon; a summary read at a distance
    // has neither, so it says so plainly rather than guessing.
    it("never claims an open tab or unsent words for an agent it read at a distance", () => {
        otherBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [agent({})])];
        expect(otherFleet.value[0]).toMatchObject({ open: false, unsent: false, sandboxId: `sbx-laptop` });
    });

    // `unread` is derivable since the read marker lives on the daemon entry, meaning the same thing at a distance as up
    // close.
    it("still knows an agent worked since it was last opened", () => {
        otherBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [agent({ updatedAt: 500, seenAt: 100 })])];
        expect(otherFleet.value[0]?.unread).toBe(true);
    });

    it("does not call a running turn unread", () => {
        otherBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [agent({ status: `running`, updatedAt: 500, seenAt: 100 })])];
        expect(otherFleet.value[0]?.unread).toBe(false);
    });

    // A box read at a distance is polled, not streamed, so its own answer to a press is the slowest thing on the board;
    // the press draws at once, and only on the box it was made in, since agent ids are minted per daemon.
    it("draws a press on another box's card at once, and on no other box's card with the same id", () => {
        otherBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [agent({ status: `error` })]), boxOf(`sbx-desk`, `Desk`, [agent({ status: `error` })])];

        const press = claim(`a1`, `sbx-laptop`, `land`);
        expect(otherFleet.value.map((card) => [card.sandboxId, card.status])).toEqual([
            [`sbx-laptop`, `landing`],
            [`sbx-desk`, `error`],
        ]);

        press.settle(false);
        expect(otherFleet.value.map((card) => card.status)).toEqual([`error`, `error`]);
    });
});

describe("isRemote", () => {
    // `undefined` and "the active one" mean the same thing and must never be told apart by accident.
    it("reads a card with no box as this sandbox's own", () => {
        expect(isRemote({ sandboxId: undefined })).toBe(false);
    });

    it("reads a card naming the active sandbox as this sandbox's own", () => {
        expect(isRemote({ sandboxId: `sbx-here` })).toBe(false);
    });

    it("reads a card naming another sandbox as elsewhere", () => {
        expect(isRemote({ sandboxId: `sbx-laptop` })).toBe(true);
    });
});

describe("crossing to the agent's own sandbox", () => {
    // The destination is recorded before the selection moves: a switch lands on whatever that box was last showing, so
    // pushing the route after would usually lose the race.
    it("aims the landing first, then switches", () => {
        openInSandbox(`sbx-laptop`, `a1`);
        expect(landOnAfterSwitch).toHaveBeenCalledWith(`sbx-laptop`, `/agents/a1`);
        expect(select).toHaveBeenCalledWith(`sbx-laptop`);
        expect(landOnAfterSwitch.mock.invocationCallOrder[0]).toBeLessThan(select.mock.invocationCallOrder[0]!);
    });

    it("escapes an agent id that would otherwise break the path", () => {
        openInSandbox(`sbx-laptop`, `a/1?x`);
        expect(landOnAfterSwitch).toHaveBeenCalledWith(`sbx-laptop`, `/agents/a%2F1%3Fx`);
    });
});

describe("naming a box on a card", () => {
    it("reads the name from the roster, so a rename reaches every card at once", () => {
        expect(boxNameOf.value.get(`sbx-laptop`)).toBe(`Laptop`);
        sandboxes.value = [...sandboxes.value.slice(0, 1), { id: `sbx-laptop`, name: `Travel laptop`, image: null, lastSeenAt: `x` }];
        expect(boxNameOf.value.get(`sbx-laptop`)).toBe(`Travel laptop`);
    });
});
