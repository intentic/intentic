import { resetSandboxScope } from "@intentic/extension-api";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// The daemon's answers to the card writes, one mock per procedure, each held open until a case settles it.
const daemon = { rename: jest.fn(), autoLand: jest.fn(), breakPolicy: jest.fn(), stopWatching: jest.fn() };

// The fleet store pulls useChat and the app shell at import time; these cut the edges that reach `window.env` (router,
// analytics, sandbox client, diagnostics) without touching the merge under test. The same cuts as useAgents.test.ts.
jest.mock("../../../router", () => ({ router: { push: jest.fn() } }));
jest.mock("../../../app/analytics", () => ({ track: jest.fn() }));
jest.mock("../../sandbox/client/useSandbox", () => ({
    useSandbox: () => ({ activeSandboxId: ref<string | undefined>(undefined), reachable: ref(false) }),
}));
jest.mock("../../sandbox/overview/activeSandbox", () => ({ sandboxKey: (...parts: unknown[]) => [...parts, `sbx-1`] }));
jest.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agents: daemon }) }));
jest.mock("../../sandbox/client/sandboxClient", () => ({ sandboxJson: jest.fn(), sandboxRequest: jest.fn() }));
jest.mock("../../../app/clientDiagnostics", () => ({ reportClient: jest.fn() }));

import type { AgentSummary } from "@intentic/sandbox-contract";
import { ref } from "vue";
import { useAgents } from "./useAgents";
import type { FleetAgent } from "./useAgents-fleet";
import { CEILING_MS, GRACE_MS, claim, hold, pendingOn } from "./useAgents-provisional";
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
    resetSandboxScope();
    rev = 0;
    for (const procedure of Object.values(daemon)) {
        procedure.mockReset();
    }
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
        roster(
            card(`live`, { status: `running`, startedAt: 500 }),
            card(`done`),
            card(`asks`, { status: `awaiting`, attention: { ...none, question: true } }),
        );

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

        resetSandboxScope();
        roster(card(`a1`, { status: `ready` }));

        expect(shown(`a1`)?.status).toBe(`ready`);
    });
});

describe("the board action out on a card", () => {
    // Keyed by (box, id), since ids repeat across boxes: no other card's press or answer may spin or quiet this one.
    it("scopes each action to its own card and box, and lifts only its own", () => {
        const at = (): unknown[] => [pendingOn(`a`), pendingOn(`b`), pendingOn(`a`, `box-2`)];
        const liftA = hold(`a`, undefined, { action: `resolve` });
        const liftB = hold(`b`, undefined, { action: `stop` });
        const liftThere = hold(`a`, `box-2`, { action: `land` });
        expect(at()).toEqual([`resolve`, `stop`, `land`]);

        liftA();
        expect(at()).toEqual([undefined, `stop`, `land`]);
        liftThere();
        liftB();
        expect(at()).toEqual([undefined, undefined, undefined]);
    });

    it("keeps a claim drawn when the action beside it lifts", () => {
        roster(card(`a1`, { status: `ready` }));
        const lift = hold(`a1`, undefined, { action: `land` });
        claim(`a1`, undefined, `land`);

        lift();

        expect({ pending: pendingOn(`a1`), status: shown(`a1`)?.status }).toEqual({ pending: undefined, status: `landing` });
    });

    it("lifts nothing from the next board when its press answers after a switch", () => {
        const lift = hold(`a`, undefined, { action: `resolve` });
        resetSandboxScope();
        const next = hold(`a`, undefined, { action: `stop` });

        lift();

        expect(pendingOn(`a`)).toBe(`stop`);
        next();
    });
});

describe("a write drawn from the press", () => {
    const first = { id: `w1`, note: `CI`, intervalSeconds: 60, deadlineAt: 9_000 };
    const second = { id: `w2`, note: `deploy`, intervalSeconds: 60, deadlineAt: 9_000 };
    const before = card(`a1`, { status: `idle`, title: `Old name`, autoLand: true, outagePolicy: `wait`, watches: [first, second] });
    // The daemon's own word, different from both `before` and every drawn value, so a lingering draw shows.
    const answered = card(`a1`, { status: `idle`, title: `The daemon's name`, autoLand: false, outagePolicy: `retry`, watches: [first] });
    // Each write, the procedure it goes through, and the fields it draws until that procedure answers.
    const writes: [string, () => Promise<void>, keyof typeof daemon, Partial<AgentSummary>][] = [
        [`a rename, trimmed`, () => useAgents().rename(`a1`, `  New name `), `rename`, { title: `New name` }],
        [`an auto-land cleared back to inherit`, () => useAgents().setAutoLand(`a1`, null), `autoLand`, { autoLand: undefined }],
        [
            `a policy its ending cannot take, as inherit`,
            () => useAgents().setBreakPolicy(`a1`, `outage`, `move`),
            `breakPolicy`,
            { outagePolicy: undefined },
        ],
        [`one watch disarmed`, () => useAgents().stopWatching(`a1`, `w1`), `stopWatching`, { watches: [second] }],
        [`every watch disarmed`, () => useAgents().stopWatching(`a1`), `stopWatching`, { watches: undefined }],
    ];
    const fieldsOf = (fields: Partial<AgentSummary>, of: Partial<FleetAgent> | undefined = shown(`a1`)): Record<string, unknown> =>
        Object.fromEntries(Object.keys(fields).map((key) => [key, of?.[key as keyof FleetAgent]]));

    it.each(writes)(`draws %s over every frame before its answer, then the answer itself`, async (_, press, procedure, drawn) => {
        roster(before);
        let answer: (summary: AgentSummary) => void = () => undefined;
        daemon[procedure].mockImplementation(() => new Promise((settle) => (answer = settle)));

        const pressed = press();
        expect(fieldsOf(drawn)).toEqual(drawn);
        roster(before);
        expect(fieldsOf(drawn)).toEqual(drawn);

        answer(answered);
        await pressed;
        expect(fieldsOf(drawn)).toEqual(fieldsOf(drawn, answered));
    });

    it("puts the daemon's own value back when the write is refused", async () => {
        roster(before);
        daemon.autoLand.mockRejectedValue(new Error(`refused`));

        await expect(useAgents().setAutoLand(`a1`, false)).rejects.toThrow(`refused`);

        expect(shown(`a1`)?.autoLand).toBe(true);
    });
});
