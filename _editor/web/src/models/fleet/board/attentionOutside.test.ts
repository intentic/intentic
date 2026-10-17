import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { effectScope, ref } from "vue";
import { projectScope, setProjectScope } from "../../../app/projectScope";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import { ownerFilter } from "../../agent-status/ownership";
import type { FleetAgent } from "../useAgents-fleet";

// A press on the Agents tile with the board already open: it must widen exactly the choices that hide something that
// needs the reader, and tell the board to show it.

const card = (id: string, startIn: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `awaiting`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    startIn,
    ...over,
});

const fleet = ref<readonly FleetAgent[]>([]);
jest.mock("../useAgents", () => ({ useAgents: () => ({ fleet, heldWakes: ref([]), attention: ref(1) }) }));

const { askForAttention, attentionAsk, attentionOutsideProject, trackScopeInputs } = await import("./attentionOutside");

beforeEach(() => {
    localStorage.clear();
    resetSandboxScope();
    ownerFilter.value = undefined;
    fleet.value = [];
    effectScope().run(() => trackScopeInputs(ref([]), ref(`me@example.com`)));
});

describe(`the Agents tile pressed on the board`, () => {
    it(`says how many sit outside the open project`, () => {
        fleet.value = [card(`a`, `shop`), card(`b`, `api`), card(`c`, `web`)];
        setProjectScope(`shop`);

        expect(attentionOutsideProject.value).toBe(2);
    });

    it(`clears a project that hides what needs the reader, and asks the board to show it`, () => {
        fleet.value = [card(`a`, `shop`), card(`b`, `api`)];
        setProjectScope(`shop`);
        const before = attentionAsk.value;

        askForAttention();

        expect(projectScope.value).toBeUndefined();
        expect(attentionAsk.value).toBe(before + 1);
    });

    it(`keeps a project that hides nothing, still taking the reader to the lane`, () => {
        fleet.value = [card(`a`, `shop`)];
        setProjectScope(`shop`);
        const before = attentionAsk.value;

        askForAttention();

        expect(projectScope.value).toBe(`shop`);
        expect(attentionAsk.value).toBe(before + 1);
    });

    it(`clears a person's chip that hides a card, and keeps one that does not`, () => {
        fleet.value = [card(`a`, `shop`, { owner: { email: `me@example.com`, since: 1 } }), card(`b`, `shop`, { owner: { email: `ada@example.com`, since: 1 } })];
        ownerFilter.value = `me@example.com`;
        askForAttention();
        expect(ownerFilter.value).toBeUndefined();

        fleet.value = [card(`a`, `shop`, { owner: { email: `me@example.com`, since: 1 } })];
        ownerFilter.value = `me@example.com`;
        askForAttention();
        expect(ownerFilter.value).toBe(`me@example.com`);
    });
});
