// @vitest-environment jsdom
//
// jsdom because the subject mounts: `watchAgentsScope` holds a subscription for a component's lifetime, and
// the property worth pinning is that it lets go. The rest is derivation and would run anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";

/* WHAT THE AGENTS TILE SAYS. Two facts are pinned here and neither can be read off the code:
 *
 * THE COUNT FOLLOWS THE BOARD'S SCOPE. This is the §9 rule that shipped unwired: a rail badge of 2 opening onto
 * a board showing 5 is worse than no badge, and so is a silent rail over an agent blocked in the box the board
 * is currently about. Both directions are tested, because the bug was one number serving two scopes.
 *
 * AND IT SAYS WHAT IT COULD NOT SEE. A badge is one digit and cannot be partly unknown, so a box that did not
 * answer has to be named in words beside it, or the digit reads as the whole answer. */

const attention = ref(0);
vi.mock("./useAgents", () => ({ useAgents: () => ({ attention }) }));

const silentBoxes = ref<{ sandbox: { name: string } }[]>([]);
const release = vi.fn();
const subscribe = vi.fn(() => release);
vi.mock("../sandbox/fleetAcross", () => ({ silentBoxes, subscribe }));

const readingAcross = ref(false);
const acrossAttention = ref(0);
// The read-marker watch is the scope module's own (fleetScope), tested there against a real conversation; here
// it only has to be registered, so it is a spy the mount assertions can ignore.
const watchRemoteSeen = vi.fn();
vi.mock("./fleetScope", () => ({
    readingAcross,
    acrossAttention,
    watchRemoteSeen,
    listNames: (names: readonly string[]) => names.join(`, `),
}));

const { agentsAttention, agentsBadge, agentsScopeNote, watchAgentsScope } = await import("./agentsTile");

// The composable under a real component, since its whole contract is "for as long as this is mounted".
const mount = (): { unmount: () => void } => {
    const app = createApp(
        defineComponent({
            setup() {
                watchAgentsScope();
                return () => h(`div`);
            },
        }),
    );
    app.mount(document.createElement(`div`));
    return { unmount: () => app.unmount() };
};

beforeEach(() => {
    attention.value = 0;
    acrossAttention.value = 0;
    readingAcross.value = false;
    silentBoxes.value = [];
    subscribe.mockClear();
    release.mockClear();
});

describe("what the badge counts", () => {
    it("counts this sandbox alone while the board is about this sandbox", () => {
        attention.value = 2;
        acrossAttention.value = 7;
        expect(agentsAttention.value).toBe(2);
        expect(agentsBadge.value).toMatchObject({ count: 2 });
    });

    // The half that was missing: with the board wide, the tile is about every box the board is about.
    it("counts every sandbox the board is reading", () => {
        attention.value = 2;
        acrossAttention.value = 3;
        readingAcross.value = true;
        expect(agentsAttention.value).toBe(5);
        expect(agentsBadge.value).toMatchObject({ count: 5 });
    });

    // …and the other direction, which is the case a box-local badge is silent about entirely.
    it("badges for work that is only in another sandbox", () => {
        acrossAttention.value = 1;
        readingAcross.value = true;
        expect(agentsBadge.value).toMatchObject({ count: 1 });
    });

    it("draws nothing when nothing is owed anywhere", () => {
        readingAcross.value = true;
        expect(agentsBadge.value).toBeUndefined();
    });

    /* THE SPLIT IS THE NUMBER THAT DECIDES THE NEXT PRESS: open the board, or cross to that box. One sentence
     * on the tile's own label, never a second badge. */
    it("says how much of the total is elsewhere", () => {
        attention.value = 2;
        acrossAttention.value = 3;
        readingAcross.value = true;
        expect(agentsBadge.value?.tooltip).toBe(`5 need you, 3 in other sandboxes`);
    });

    it("does not mention elsewhere when there is nothing there", () => {
        attention.value = 1;
        readingAcross.value = true;
        expect(agentsBadge.value?.tooltip).toBe(`1 needs you`);
    });
});

describe("what the tile says about its own scope", () => {
    it("says nothing while the board is about this sandbox", () => {
        silentBoxes.value = [{ sandbox: { name: `Laptop` } }];
        expect(agentsScopeNote.value).toBeUndefined();
    });

    it("says the count is about every sandbox once the board is wide", () => {
        readingAcross.value = true;
        expect(agentsScopeNote.value).toBe(`Counting every sandbox`);
    });

    // A count over boxes that did not all answer is partial, and the tile has one digit and no way to show it:
    // so it names them. Rendering the silence as nothing is the `live: true` failure this design keeps catching.
    it("names the boxes it could not reach", () => {
        readingAcross.value = true;
        silentBoxes.value = [{ sandbox: { name: `Laptop` } }, { sandbox: { name: `Pi` } }];
        expect(agentsScopeNote.value).toBe(`Counting every sandbox except Laptop, Pi, which aren't answering`);
    });
});

describe("keeping the other boxes live", () => {
    afterEach(() => {
        readingAcross.value = false;
    });

    it("does not poll anything while the board is about this sandbox", () => {
        const app = mount();
        expect(subscribe).not.toHaveBeenCalled();
        app.unmount();
    });

    it("subscribes as soon as the badge is about other boxes", async () => {
        const app = mount();
        readingAcross.value = true;
        await Promise.resolve();
        expect(subscribe).toHaveBeenCalledTimes(1);
        app.unmount();
    });

    // Narrowing the scope stops the poll: the store's whole claim is that it is inert when nothing reads it.
    it("lets go when the scope narrows again", async () => {
        const app = mount();
        readingAcross.value = true;
        await Promise.resolve();
        readingAcross.value = false;
        await Promise.resolve();
        expect(release).toHaveBeenCalledTimes(1);
        app.unmount();
    });

    it("holds exactly one subscription while the scope stays wide", async () => {
        const app = mount();
        readingAcross.value = true;
        await Promise.resolve();
        silentBoxes.value = [{ sandbox: { name: `Laptop` } }];
        await Promise.resolve();
        expect(subscribe).toHaveBeenCalledTimes(1);
        app.unmount();
    });

    // A shell that goes away takes the poll with it, whatever the scope was when it left.
    it("releases on unmount", async () => {
        const app = mount();
        readingAcross.value = true;
        await Promise.resolve();
        app.unmount();
        expect(release).toHaveBeenCalledTimes(1);
    });
});
