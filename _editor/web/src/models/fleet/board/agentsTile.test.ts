// jsdom: the tile's watch mounts inside a component for the shell's lifetime.
import "@intentic/testing/dom";
import { createApp, defineComponent, h, ref } from "vue";

// Pinned: the badge counts this sandbox alone (other sandboxes are Home's to show), and its tooltip says how much of the
// count the open project keeps off the board.

const attention = ref(0);
// The cards behind the count, for the part of it the open project keeps off the board.
const fleet = ref<unknown[]>([]);
jest.mock("../useAgents", () => ({ useAgents: () => ({ attention, fleet, heldWakes: ref([]) }) }));
// Read by the tile's own watch, which this test mounts outside any sandbox or session.
jest.mock("../../sandbox/personas/usePersonas", () => ({ usePersonas: () => ({ personas: ref([]) }) }));
jest.mock("../../../client/auth/useAuth", () => ({ useAuth: () => ({ user: ref(null) }) }));

// The read-marker watch is fleetScope's own, tested there; here it is a spy.
const watchRemoteSeen = jest.fn();
jest.mock("../fleetScope", () => ({ watchRemoteSeen }));

const { projectScope, setProjectScope } = await import("../../../app/projectScope");
const { agentsAttention, agentsBadge, watchAgentsScope } = await import("./agentsTile");

beforeEach(() => {
    attention.value = 0;
    fleet.value = [];
});

describe("what the badge counts", () => {
    it("counts this sandbox's attention", () => {
        attention.value = 2;
        expect(agentsAttention.value).toBe(2);
        expect(agentsBadge.value).toMatchObject({ count: 2, tooltip: `2 need you` });
    });

    it("draws nothing when nothing is owed", () => {
        expect(agentsBadge.value).toBeUndefined();
    });

    // The count is the sandbox's and the board shows the open project: the tooltip says how much of it that hides.
    it("says how much of the count sits outside the open project", () => {
        const asking = (id: string, startIn: string) => ({ id, title: id, status: `awaiting`, updatedAt: 1, attention: {}, startIn });
        fleet.value = [asking(`a`, `shop`), asking(`b`, `api`)];
        attention.value = 2;
        setProjectScope(`shop`);
        expect(agentsBadge.value?.tooltip).toBe(`2 need you (1 outside shop)`);

        setProjectScope(undefined);
        expect(agentsBadge.value?.tooltip).toBe(`2 need you`);
        expect(projectScope.value).toBeUndefined();
    });
});

describe("the tile's watch", () => {
    it("marks a chat placed elsewhere read, once per shell", () => {
        watchRemoteSeen.mockClear();
        const app = createApp(
            defineComponent({
                setup() {
                    watchAgentsScope();
                    return () => h(`div`);
                },
            }),
        );
        app.mount(document.createElement(`div`));
        expect(watchRemoteSeen).toHaveBeenCalledTimes(1);
        app.unmount();
    });
});
