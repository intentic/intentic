// @vitest-environment jsdom
//
// jsdom because `fleetScope` declares an account preference, and a preference is read from localStorage and
// announced on a BroadcastChannel at module load (ui/composables/preference.ts). Neither exists in the node
// environment, and stubbing them would be stubbing the thing under test's own storage.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref } from "vue";
import type { AgentSummary } from "@intentic/sandbox-contract";

const sandboxes = ref<{ id: string; name: string; image: string | null; lastSeenAt: string | null }[]>([]);
const activeSandboxId = ref<string | undefined>(`sbx-here`);
const select = vi.fn();
vi.mock("../sandbox/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId, select }) }));

// The store this reads from, stubbed to the shape its surfaces see: what it does with the network is
// fleetAcross's own business and is tested there.
const otherBoxes = ref<unknown[]>([]);
const silentBoxes = ref<unknown[]>([]);
// `boxAttention` is the store's own per-box reading, stubbed to the two answers it can give: a number, or
// undefined for a box that has never answered (the case the sum below must not turn into a zero).
const boxAttention = (box: { attention?: number }): number | undefined => box.attention;
vi.mock("../sandbox/fleetAcross", () => ({ otherBoxes, silentBoxes, boxAttention, subscribe: vi.fn(), refreshAcross: vi.fn() }));

const landOnAfterSwitch = vi.fn();
vi.mock("../sandbox/sandboxScreen", () => ({ landOnAfterSwitch }));

const { acrossAttention, boxNameOf, isRemote, openInSandbox, otherFleet, partialAnswer, fleetScope, readingAcross, scopeOffered } =
    await import("./fleetScope");

const none = { plan: false, question: false, permission: false, service: false, capability: false, conflict: false };
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
    // One connected sandbox is not a fleet: a switch whose two settings produce the same screen teaches a
    // reader only to stop reading controls.
    it("is not offered on an account with a single sandbox", () => {
        sandboxes.value = [{ id: `sbx-here`, name: `Desk`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` }];
        expect(scopeOffered.value).toBe(false);
    });

    // A sandbox that never checked in has no daemon to read, so it is not somewhere else to look.
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

    /* A STORED PREFERENCE DOES NOT MAKE A BOARD READ ACROSS NOTHING. An account that drops to one sandbox keeps
     * its `all` (they will likely add another) and the board quietly behaves as `box` until there is a second
     * one, rather than drawing a scope that resolves to an empty half. */
    it("stops reading across when there is nowhere else, without forgetting the choice", () => {
        fleetScope.value = `all`;
        expect(readingAcross.value).toBe(true);
        sandboxes.value = [{ id: `sbx-here`, name: `Desk`, image: null, lastSeenAt: `2026-01-01T00:00:00Z` }];
        expect(readingAcross.value).toBe(false);
        expect(fleetScope.value).toBe(`all`);
    });
});

describe("another box's agents as board cards", () => {
    /* THE HALVES ONLY A LOCAL CONVERSATION CAN ANSWER ARE FALSE, not guessed. `open` and `unsent` are facts
     * about a tab in THIS browser pointed at THIS daemon, and a summary read at a distance has neither, so
     * saying so plainly is what keeps the card from claiming unsent words nobody can see. */
    it("never claims an open tab or unsent words for an agent it read at a distance", () => {
        otherBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [agent({})])];
        expect(otherFleet.value[0]).toMatchObject({ open: false, unsent: false, sandboxId: `sbx-laptop` });
    });

    // `unread` IS derivable, because the read marker lives on the daemon entry rather than in this browser: it
    // means the same thing at a distance as it does up close.
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
    // `undefined` and "the active one" mean the same thing and must never be told apart by accident: every
    // action on the board asks this before it decides which daemon to address.
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

    /* NAMES, NOT A COUNT. The name is what tells a reader whether the box that did not answer is the one they
     * came for, which "1 sandbox is unavailable" cannot. */
    it("names the box that did not answer", () => {
        fleetScope.value = `all`;
        silentBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, [])];
        expect(partialAnswer.value).toContain(`Laptop`);
    });

    it("names several, and agrees with itself about number", () => {
        fleetScope.value = `all`;
        silentBoxes.value = [boxOf(`sbx-laptop`, `Laptop`, []), boxOf(`sbx-pi`, `Pi`, [])];
        expect(partialAnswer.value).toContain(`Laptop`);
        expect(partialAnswer.value).toContain(`Pi`);
    });
});

describe("how much the other boxes are owed", () => {
    it("adds up what every other box says it needs", () => {
        otherBoxes.value = [{ ...(boxOf(`sbx-laptop`, `Laptop`, []) as object), attention: 2 }, { ...(boxOf(`sbx-pi`, `Pi`, []) as object), attention: 3 }];
        expect(acrossAttention.value).toBe(5);
    });

    /* A BOX THAT HAS NEVER ANSWERED CONTRIBUTES NOTHING AND BLOCKS NOTHING. The switcher can draw a dash on its
     * row because it has a row per box; a badge has one digit, so the unknown is told beside it in words
     * (agentsTile.scopeNote) rather than being smuggled into the number or suppressing it. */
    it("skips a box that has never answered rather than counting it as zero or giving up", () => {
        otherBoxes.value = [{ ...(boxOf(`sbx-laptop`, `Laptop`, []) as object), attention: 2 }, { ...(boxOf(`sbx-pi`, `Pi`, []) as object), attention: undefined }];
        expect(acrossAttention.value).toBe(2);
    });
});

describe("crossing to the agent's own sandbox", () => {
    /* THE DESTINATION IS RECORDED BEFORE THE SELECTION MOVES. A switch lands on whatever that box was last
     * showing (sandboxScreen), so pushing the route afterwards would race that landing and usually lose: the
     * reader would arrive at the box's last screen instead of the agent they pressed. */
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
