// @vitest-environment jsdom
// jsdom: the subject mounts and holds a subscription for the component's lifetime; the property under test is that it
// lets go.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, defineComponent, h, ref } from "vue";

// Two facts pinned: the badge count follows the board's scope (both directions), and it says what it could not see
// (silent boxes), since a badge is one digit and cannot be partly unknown.

const attention = ref(0);
vi.mock("../fleet/useAgents", () => ({ useAgents: () => ({ attention }) }));

const silentBoxes = ref<{ sandbox: { name: string } }[]>([]);
const release = vi.fn();
const subscribe = vi.fn(() => release);
vi.mock("../../sandbox/live/fleetAcross", () => ({ silentBoxes, subscribe }));

const readingAcross = ref(false);
const acrossAttention = ref(0);
// The read-marker watch is fleetScope's own, tested there; here it is a spy the mount assertions can ignore.
const watchRemoteSeen = vi.fn();
vi.mock("../fleet/fleetScope", () => ({
    readingAcross,
    acrossAttention,
    watchRemoteSeen,
    listNames: (names: readonly string[]) => names.join(`, `),
}));

const { agentsAttention, agentsBadge, agentsScopeNote, watchAgentsScope } = await import("./agentsTile");

// The composable inside a real component: its whole contract is "for as long as this is mounted".
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

    // With the board wide, the tile counts every box the board is about.
    it("counts every sandbox the board is reading", () => {
        attention.value = 2;
        acrossAttention.value = 3;
        readingAcross.value = true;
        expect(agentsAttention.value).toBe(5);
        expect(agentsBadge.value).toMatchObject({ count: 5 });
    });

    // The other direction: a badge for work that is only in another sandbox.
    it("badges for work that is only in another sandbox", () => {
        acrossAttention.value = 1;
        readingAcross.value = true;
        expect(agentsBadge.value).toMatchObject({ count: 1 });
    });

    it("draws nothing when nothing is owed anywhere", () => {
        readingAcross.value = true;
        expect(agentsBadge.value).toBeUndefined();
    });

    // The split is the number that decides the next press: open the board, or cross to that box. One sentence, never a
    // second badge.
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

    // A count over boxes that didn't all answer is partial; the tile has one digit, so it names them instead of staying
    // silent.
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

    // Narrowing the scope stops the poll: the store is inert when nothing reads it.
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

    // An unmounted shell takes the poll with it, whatever the scope was.
    it("releases on unmount", async () => {
        const app = mount();
        readingAcross.value = true;
        await Promise.resolve();
        app.unmount();
        expect(release).toHaveBeenCalledTimes(1);
    });
});
