// @vitest-environment jsdom
// jsdom: fleetScope declares an account preference read from localStorage and announced on a BroadcastChannel at module
// load, neither of which exists in the node environment.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { AgentSummary } from "@intentic/sandbox-contract";

const sandboxes = ref<{ id: string; name: string; image: string | null; lastSeenAt: string | null }[]>([]);
const activeSandboxId = ref<string | undefined>(`sbx-here`);
const select = vi.fn();
vi.mock("../../sandbox/client/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId, select }) }));

// The store this reads from, stubbed to the shape its surfaces see; what it does with the network is fleetAcross's own
// business.
const otherBoxes = ref<unknown[]>([]);
const silentBoxes = ref<unknown[]>([]);
// `boxAttention` stubbed to its two real answers: a number, or undefined for a box that's never answered, the case the
// sum below must not turn into a zero.
const boxAttention = (box: { attention?: number }): number | undefined => box.attention;
vi.mock("../../sandbox/live/fleetAcross", () => ({ otherBoxes, silentBoxes, boxAttention, subscribe: vi.fn(), refreshAcross: vi.fn() }));

const landOnAfterSwitch = vi.fn();
vi.mock("../../sandbox/client/sandboxScreen", () => ({ landOnAfterSwitch }));

const { acrossAttention, boxNameOf, isRemote, openInSandbox, otherFleet, partialAnswer, fleetScope, readingAcross, scopeOffered } =
    await import("./fleetScope");

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
    fleetScope.value = `box`;
    otherBoxes.value = [];
    silentBoxes.value = [];
    activeSandboxId.value = `sbx-here`;
    sandboxes.value = [
        { id: `sbx-here`, name: `Desk`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` },
        { id: `sbx-laptop`, name: `Laptop`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` },
    ];
    select.mockClear();
    landOnAfterSwitch.mockClear();
});

describe("whether the scope is offered at all", () => {
    // One connected sandbox is not a fleet: a switch whose two settings produce the same screen only teaches a reader
    // to stop reading controls.
    it("is not offered on an account with a single sandbox", () => {
        sandboxes.value = [{ id: `sbx-here`, name: `Desk`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` }];
        expect(scopeOffered.value).toBe(false);
    });

    // A sandbox that never checked in has no daemon to read, so it isn't somewhere else to look.
    it("does not count an unfinished setup as somewhere else to look", () => {
        sandboxes.value = [
            { id: `sbx-here`, name: `Desk`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` },
            { id: `sbx-half`, name: `Half`, image: null, lastSeenAt: null },
        ];
        expect(scopeOffered.value).toBe(false);
    });

    it("is offered once a second sandbox has checked in", () => {
        expect(scopeOffered.value).toBe(true);
    });

    // A stored preference doesn't make a board read across nothing: an account that drops to one sandbox keeps its
    // `all` choice and behaves as `box` until there's a second one again.
    it("stops reading across when there is nowhere else, without forgetting the choice", () => {
        fleetScope.value = `all`;
        expect(readingAcross.value).toBe(true);
        sandboxes.value = [{ id: `sbx-here`, name: `Desk`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` }];
        expect(readingAcross.value).toBe(false);
        expect(fleetScope.value).toBe(`all`);
    });
});

describe("another box's agents as board cards", () => {
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

describe("what the board says when its answer is partial", () => {
    it("says nothing while the board is only about this sandbox", () => {
        silentBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [])];
        expect(partialAnswer.value).toBeUndefined();
    });

    it("says nothing when every box answered", () => {
        fleetScope.value = `all`;
        expect(partialAnswer.value).toBeUndefined();
    });

    // Names, not a count: the name is what tells a reader whether the box that didn't answer is the one they came for.
    it("names the box that did not answer", () => {
        fleetScope.value = `all`;
        silentBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [])];
        expect(partialAnswer.value?.title).toContain(`Laptop`);
        expect(partialAnswer.value?.title).toContain(`isn't`);
        expect(partialAnswer.value?.detail).toContain(`it`);
    });

    it("names several, and agrees with itself about number", () => {
        fleetScope.value = `all`;
        silentBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, []), boxOf(`sbx-pi`, `Pi`, [])];
        expect(partialAnswer.value?.title).toContain(`Laptop`);
        expect(partialAnswer.value?.title).toContain(`Pi`);
        expect(partialAnswer.value?.title).toContain(`aren't`);
        expect(partialAnswer.value?.detail).toContain(`them`);
    });
});

describe("how much the other boxes are owed", () => {
    it("adds up what every other box says it needs", () => {
        otherBoxes.value = [{ ...(boxOf(`sbx-laptop`, `Laptop`, []) as object), attention: 2 }, { ...(boxOf(`sbx-pi`, `Pi`, []) as object), attention: 3 }];
        expect(acrossAttention.value).toBe(5);
    });

    // A box that has never answered contributes nothing and blocks nothing: the switcher can draw a dash per row, but a
    // badge has one digit, so the unknown is told in words instead.
    it("skips a box that has never answered rather than counting it as zero or giving up", () => {
        otherBoxes.value = [{ ...(boxOf(`sbx-laptop`, `Laptop`, []) as object), attention: 2 }, { ...(boxOf(`sbx-pi`, `Pi`, []) as object), attention: undefined }];
        expect(acrossAttention.value).toBe(2);
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
