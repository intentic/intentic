import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";

// The fleet store pulls useChat and the app shell at import time; these cut the edges that reach `window.env` (router,
// analytics, sandbox client, diagnostics) without touching the merge under test. The same cuts as useAgents.test.ts.
mock.module("../../../router", () => ({ router: { push: mock() } }));
mock.module("../../../app/analytics", () => ({ track: mock() }));
mock.module("../../sandbox/client/useSandbox", () => ({ useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }) }));
mock.module("../../sandbox/overview/activeSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`] }));
mock.module("../../sandbox/client/sandboxClient", () => ({ sandboxJson: mock(), sandboxRequest: mock() }));
mock.module("../../../app/clientDiagnostics", () => ({ reportClient: mock() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { resetAgents, useAgents } from "./useAgents";
import { CEILING_MS, GRACE_MS, claim } from "./useAgents-provisional";
import { setAgents } from "./useAgents-registry";

const none = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const card = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: none,
    ...over,
});
const refused = (id: string, over: Partial<AgentSummary> = {}): AgentSummary =>
    card(id, { status: `conflict`, attention: { ...none, conflict: true }, conflictCauses: [`diverged`], ...over });

// Every roster frame at the next revision, as the stream delivers them.
let rev = 0;
const roster = (...agents: AgentSummary[]): void => setAgents(agents, (rev += 1));

const shown = (id: string) => useAgents().fleet.value.find((agent) => agent.id === id);
const laneOf = (id: string): string | undefined =>
    Object.entries(useAgents().lanes.value).find(([, cards]) => cards.some((agent) => agent.id === id))?.[0];

beforeEach(() => {
    resetAgents();
    rev = 0;
});

afterEach(() => {
    jest.useRealTimers();
});

describe("what a press draws before the daemon answers", () => {
    // What the board is asked for: the card moves in the frame of the press, in the shape the daemon's own frame will
    // give it, so the handover to that frame changes nothing on screen.
    it("draws a pressed turn at once, the conflict it answers already gone", () => {
        roster(refused(`a1`));

        claim(`a1`, undefined, `turn`);

        expect(laneOf(`a1`)).toBe(`active`);
        expect(shown(`a1`)).toMatchObject({ status: `running`, attention: none, unread: false });
        expect(shown(`a1`)?.conflictCauses).toBeUndefined();
    });

    it("draws a Stop as the stopping it will become, in the lane stopping rests in", () => {
        roster(card(`a1`, { status: `running`, startedAt: 500 }));

        claim(`a1`, undefined, `stop`);

        expect(shown(`a1`)?.status).toBe(`stopping`);
        expect(laneOf(`a1`)).toBe(`attention`);
    });

    it("draws a land from an errored card straight into Finished, its failure going with the status it came from", () => {
        roster(card(`a1`, { status: `error`, failure: `The harness exited.` }));

        claim(`a1`, undefined, `land`);

        expect(shown(`a1`)).toMatchObject({ status: `landing` });
        expect(shown(`a1`)?.failure).toBeUndefined();
        expect(laneOf(`a1`)).toBe(`finished`);
    });

    it("takes a discarded card off the board ahead of the roster", () => {
        roster(card(`a1`), card(`a2`));

        claim(`a1`, undefined, `discard`);

        expect(shown(`a1`)).toBeUndefined();
        expect(shown(`a2`)?.status).toBe(`landed`);
    });

    // A claim may only draw what the daemon could reach from where the card really is: a turn's own land reads
    // `running`, a settled card has nothing to stop, and a parked turn is answered rather than restarted.
    it("draws nothing the card's real standing couldn't reach", () => {
        roster(card(`live`, { status: `running`, startedAt: 500 }), card(`done`), card(`asks`, { status: `awaiting`, attention: { ...none, question: true } }));

        claim(`live`, undefined, `land`);
        claim(`done`, undefined, `stop`);
        claim(`asks`, undefined, `turn`);

        expect([`live`, `done`, `asks`].map((id) => shown(id)?.status)).toEqual([`running`, `landed`, `awaiting`]);
    });

    it("claims nothing for a card the daemon has no entry for", () => {
        const press = claim(`ghost`, undefined, `turn`);
        roster(refused(`ghost`));

        expect(press.stands()).toBe(true);
        expect(laneOf(`ghost`)).toBe(`attention`);
    });
});

describe("how a claim retires", () => {
    it("takes a refused press back at once", () => {
        roster(card(`a1`, { status: `running`, startedAt: 500 }));
        const press = claim(`a1`, undefined, `stop`);

        press.settle(false);

        expect(shown(`a1`)?.status).toBe(`running`);
        expect(laneOf(`a1`)).toBe(`active`);
    });

    // Evidence, not agreement: the first frame that moves the card past what the daemon said at the press is drawn as
    // it is, even when it says the press has not happened, since it is newer than anything the press knows.
    it("yields to the roster's first word past the press, whatever that word says", () => {
        roster(refused(`a1`));
        const press = claim(`a1`, undefined, `turn`);

        roster(refused(`a1`, { updatedAt: 2_000 }));

        expect(laneOf(`a1`)).toBe(`attention`);
        press.settle(true);
        expect(laneOf(`a1`)).toBe(`attention`);
    });

    it("keeps a taken press drawn through frames about something else, then hands over to the frame about it", () => {
        roster(card(`a1`, { status: `ready` }));
        const press = claim(`a1`, undefined, `land`);
        press.settle(true);

        // The reader's own read marker moved; the daemon has said nothing yet about the land.
        roster(card(`a1`, { status: `ready`, seenAt: 3_000 }));
        expect(shown(`a1`)?.status).toBe(`landing`);

        roster(card(`a1`, { status: `landed`, updatedAt: 2_000 }));
        expect(shown(`a1`)?.status).toBe(`landed`);
    });

    // A frame lost on the way (a dropped stream, a reconnect) must not strand the card on a guess.
    it("gives a taken press the roster never answers for back its real standing once the grace is out", async () => {
        jest.useFakeTimers();
        roster(card(`a1`, { status: `ready` }));
        claim(`a1`, undefined, `land`).settle(true);

        await advanceTimersByTimeAsync(GRACE_MS - 1);
        expect(shown(`a1`)?.status).toBe(`landing`);
        await advanceTimersByTimeAsync(1);
        expect(shown(`a1`)?.status).toBe(`ready`);
    });

    it("lets no claim outlive its ceiling, however its press is doing", async () => {
        jest.useFakeTimers();
        roster(refused(`a1`));
        claim(`a1`, undefined, `turn`);

        await advanceTimersByTimeAsync(CEILING_MS - 1);
        expect(laneOf(`a1`)).toBe(`active`);
        await advanceTimersByTimeAsync(1);
        expect(laneOf(`a1`)).toBe(`attention`);
    });

    // Two presses on one card: the newer is the one standing, and the older's answer (or timer) arriving after it
    // must not take the card back from under it.
    it("lets a later press replace an earlier one, whose answer can no longer take the card back", () => {
        roster(card(`a1`, { status: `ready` }));
        const land = claim(`a1`, undefined, `land`);
        const discard = claim(`a1`, undefined, `discard`);

        expect(land.stands()).toBe(false);
        expect(discard.stands()).toBe(true);
        land.settle(false);
        expect(shown(`a1`)).toBeUndefined();
        discard.settle(false);
        expect(shown(`a1`)?.status).toBe(`ready`);
    });

    it("forgets every claim when the board is pointed at another daemon", () => {
        roster(card(`a1`, { status: `ready` }));
        claim(`a1`, undefined, `land`);

        resetAgents();
        roster(card(`a1`, { status: `ready` }));

        expect(shown(`a1`)?.status).toBe(`ready`);
    });
});
