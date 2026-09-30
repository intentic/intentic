import { computed, shallowRef } from "vue";

// The two things a screen can be painted from before the sandbox answers, each set by the test.
const tree = shallowRef<object | undefined>(undefined);
const roster = shallowRef<object[]>([]);

jest.mock("../../workspace/explorer/useWorkspaceTree", () => ({
    useWorkspaceTree: () => ({ hasSnapshot: computed(() => tree.value !== undefined) }),
}));
jest.mock("../../agents/fleet/useAgents-registry", () => ({ registry: roster }));

const { useSandboxEstablished } = await import("./established");

// One answer for the gate and the notification lane. While they disagreed, a board drawn from a restored roster was
// neither gated nor carded, and a sandbox that had stopped answering said nothing at all.
describe(`whether a sandbox has something to paint before it answers`, () => {
    beforeEach(() => {
        tree.value = undefined;
        roster.value = [];
    });

    it(`is nothing on a first visit`, () => {
        expect(useSandboxEstablished().value).toBe(false);
    });

    it(`is the workspace tree from the last visit`, () => {
        tree.value = {};
        expect(useSandboxEstablished().value).toBe(true);
    });

    it(`is a roster restored from the last visit, which is all a phone's board draws`, () => {
        roster.value = [{ id: `a` }];
        expect(useSandboxEstablished().value).toBe(true);
    });

    it(`follows either as it changes`, () => {
        const established = useSandboxEstablished();
        roster.value = [{ id: `a` }];
        expect(established.value).toBe(true);
        roster.value = [];
        expect(established.value).toBe(false);
    });
});
