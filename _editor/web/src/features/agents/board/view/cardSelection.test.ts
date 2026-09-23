import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { WorkflowRun } from "@intentic/sandbox-contract";
import { type EffectScope, effectScope, nextTick, reactive, ref, shallowRef } from "vue";
import type { LocationQuery, RouteLocationRaw, Router } from "vue-router";
import { agentTabOf } from "../../../chat/panel/useChat-reveal";
import type { Summons } from "../../../chat/run/summon";
import { EMPTY_STRIP, type Strip, type TabFacts } from "../../../chat/tabs/tabFacts";
import { NO_ATTENTION } from "../../fleet/agentStatus";
import { isRemote } from "../../fleet/fleetScope";
import { agentSeed } from "../../fleet/useAgents-actions";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import type { ViewEvent } from "./boardView";
import { paneAsk, paneRange, useCardFocus, useCardRing } from "./cardSelection";

// Pins which card the board points at and what a press on one asks of the chat: the ring follows the chat unless a
// link's flash outranks it, a plain click is a look, a modified one composes panes, another box's card opens its
// review, and a link to a card waits for it, uncovers it, rings it and scrolls to it.

const card = (id: string, over: Partial<FleetAgent> = {}): FleetAgent => ({
    id,
    title: `agent ${id}`,
    status: `landed`,
    provider: `claude`,
    harness: `native`,
    updatedAt: 1_000,
    attention: NO_ATTENTION,
    open: false,
    unread: false,
    unsent: false,
    ...over,
});
const tab = (id: string, peek = false): TabFacts => ({
    id,
    registered: true,
    standing: `resumed`,
    provider: `claude`,
    harness: `native`,
    peek,
    standIn: false,
    model: `sonnet`,
    unsent: false,
});
const keys = (over: Partial<Record<`shiftKey` | `altKey` | `ctrlKey` | `metaKey`, boolean>> = {}) => ({
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...over,
});
const tabOf = (agent: FleetAgent) => agentTabOf(agentSeed(agent));

const running: EffectScope[] = [];
afterEach(() => {
    for (const effects of running.splice(0)) {
        effects.stop();
    }
    jest.useRealTimers();
});
const inScope = <T>(make: () => T): T => {
    const effects = effectScope();
    running.push(effects);
    return effects.run(make)!;
};

describe(`what a modified click asks for`, () => {
    it(`reads Shift as a range, Alt as a column beside, and Ctrl/Cmd as a toggle only among several panes`, () => {
        expect([
            paneAsk(keys(), false, false),
            paneAsk(keys({ shiftKey: true, altKey: true }), true, true),
            paneAsk(keys({ altKey: true }), true, true),
            paneAsk(keys({ ctrlKey: true }), true, true),
            paneAsk(keys({ metaKey: true }), true, true),
            paneAsk(keys({ ctrlKey: true }), true, false),
            paneAsk(keys({ ctrlKey: true }), false, true),
            paneAsk(keys({ ctrlKey: true, altKey: true }), true, true),
        ]).toEqual([undefined, `range`, `beside`, `unpane`, `unpane`, `beside`, `beside`, `beside`]);
    });

    it(`runs a range from the anchor to the card in drawn order, either way, and the card alone off the board`, () => {
        const order = [card(`a`), card(`b`), card(`c`), card(`d`)];
        expect(paneRange(order, `b`, order[3]!).map((agent) => agent.id)).toEqual([`b`, `c`, `d`]);
        expect(paneRange(order, `d`, order[1]!).map((agent) => agent.id)).toEqual([`b`, `c`, `d`]);
        expect(paneRange(order, `gone`, order[2]!).map((agent) => agent.id)).toEqual([`c`]);
    });
});

describe(`the ring`, () => {
    const ringOf = (strip: Strip, over: { mobile?: boolean; wide?: boolean; runs?: WorkflowRun[] } = {}) => {
        const host = {
            mobile: ref(over.mobile ?? false),
            strip: shallowRef(strip),
            wide: ref(over.wide ?? false),
            runs: shallowRef(over.runs ?? []),
        };
        return { host, ring: inScope(() => useCardRing(host)) };
    };

    it(`rings the chat's own card on desktop, a fainter one on every other pane, and none on a phone`, () => {
        const { host, ring } = ringOf({ ...EMPTY_STRIP, active: `a1`, panes: [`a1`, `a2`] });
        expect([ring.highlightId.value, ring.inPane(`a2`), ring.inPane(`a3`)]).toEqual([`a1`, true, false]);

        host.mobile.value = true;
        expect([ring.highlightId.value, ring.inPane(`a2`)]).toEqual([undefined, false]);
    });

    it(`takes the ring off every card while the wide chat draws a run's diagram`, () => {
        const run = { runId: `r1`, steps: [] } as unknown as WorkflowRun;
        const { ring } = ringOf(
            { ...EMPTY_STRIP, active: `a1`, panes: [`a1`, `a2`], run: { runId: `r1`, mode: `graph` } },
            { wide: true, runs: [run] },
        );
        expect([ring.highlightId.value, ring.inPane(`a2`)]).toEqual([undefined, false]);
    });

    it(`lets a link's flash outrank the chat's card for four seconds`, async () => {
        jest.useFakeTimers();
        const { ring } = ringOf({ ...EMPTY_STRIP, active: `a1` });
        ring.flash(`a9`);
        expect(ring.highlightId.value).toBe(`a9`);

        await advanceTimersByTimeAsync(3_999);
        expect(ring.highlightId.value).toBe(`a9`);
        await advanceTimersByTimeAsync(1);
        expect(ring.highlightId.value).toBe(`a1`);
    });

    it(`marks a chat open only as a look, on desktop`, () => {
        const { host, ring } = ringOf({ ...EMPTY_STRIP, tabs: [tab(`a1`, true), tab(`a2`)] });
        expect([ring.peeked(`a1`), ring.peeked(`a2`)]).toEqual([true, false]);
        host.mobile.value = true;
        expect(ring.peeked(`a1`)).toBe(false);
    });
});

describe(`a press on a card`, () => {
    const boardOf = (roster: FleetAgent[], strip: Strip = EMPTY_STRIP) => {
        const cards = shallowRef(roster);
        const summon = jest.fn((_summons: Summons) => undefined);
        const push = jest.fn(async (_to: RouteLocationRaw) => undefined);
        const replace = jest.fn(async (_to: RouteLocationRaw) => undefined);
        const resolve = (to: RouteLocationRaw) => ({ href: typeof to === `string` ? to : JSON.stringify(to) });
        const router = unstubbed<Router>(`router`, { push, replace, resolve: resolve as unknown as Router[`resolve`] });
        const route = reactive({ query: {} as LocationQuery });
        const reveal = jest.fn(async (_id: string) => undefined);
        const move = jest.fn((_event: ViewEvent) => undefined);
        const suppressed = { next: false };
        const host = {
            mobile: ref(false),
            strip: shallowRef(strip),
            filter: {
                active: ref(false),
                matches: (agent: FleetAgent) => agent.id !== `hidden`,
                query: ref(`log`),
                sessionMatches: shallowRef([{ id: `s1`, title: `Old chat` }]),
            },
            agents: {
                open: jest.fn((_agent: FleetAgent, _mode?: `peek` | `keep`) => undefined),
                markSeen: jest.fn((_id: string) => undefined),
                agentById: (id: string) => cards.value.find((agent) => agent.id === id),
            },
            lanes: { paneOrder: shallowRef(roster), finishedWindow: shallowRef({ shown: roster.slice(0, 2) }) },
            drag: { consumeSuppressedOpen: () => suppressed.next },
        };
        const ring = inScope(() => useCardRing({ mobile: host.mobile, strip: host.strip, wide: ref(false), runs: shallowRef([]) }));
        const focus = inScope(() => useCardFocus({ ...host, ring, move, reveal, router, route, summon }));
        return { ...host, cards, ring, focus, summon, push, replace, route, reveal, move, suppressed };
    };
    const [a1, a2, a3] = [card(`a1`), card(`a2`), card(`a3`)];

    it(`opens a look on a plain click, walking to the agent's page only on a phone`, () => {
        const board = boardOf([a1]);
        board.focus.focusAgent(a1, new MouseEvent(`click`));
        expect(board.agents.open.mock.calls).toEqual([[a1, `peek`]]);
        expect(board.push).not.toHaveBeenCalled();

        board.mobile.value = true;
        board.focus.focusAgent(a1, new MouseEvent(`click`));
        expect(board.push.mock.calls).toEqual([[`/agents/a1`]]);
    });

    it(`does nothing for the click a drag's release lands on its own card`, () => {
        const board = boardOf([a1]);
        board.suppressed.next = true;
        board.focus.focusAgent(a1);
        expect(board.agents.open).not.toHaveBeenCalled();
        expect(board.summon).not.toHaveBeenCalled();
    });

    it(`opens another box's card on its own review page, minting no tab`, () => {
        const far = card(`far`, { sandboxId: `elsewhere` });
        expect(isRemote(far)).toBe(true);
        const board = boardOf([far]);
        board.focus.focusAgent(far);
        expect(board.push.mock.calls).toEqual([[{ path: `/agents/far`, query: { sandbox: `elsewhere` } }]]);
        expect(board.agents.open).not.toHaveBeenCalled();
        expect(board.focus.agentHref(far)).toBe(JSON.stringify({ path: `/agents/far`, query: { sandbox: `elsewhere` } }));
        expect(board.focus.agentHref(a1)).toBe(`/agents/a1`);
    });

    it(`adds a column beside on Alt, marking the card read, and takes one away on Ctrl among several`, () => {
        const board = boardOf([a1, a2], { ...EMPTY_STRIP, active: `a1`, panes: [`a1`, `a2`] });
        board.focus.focusAgent(a1, new MouseEvent(`click`, { altKey: true }));
        board.focus.focusAgent(a2, new MouseEvent(`click`, { ctrlKey: true }));
        expect(board.summon.mock.calls).toEqual([
            [{ kind: `reveal`, verb: `beside`, entries: [tabOf(a1)], focus: `a1`, caret: false }],
            [{ kind: `reveal`, verb: `unpane`, entries: [], focus: `a2`, caret: false }],
        ]);
        expect(board.agents.markSeen.mock.calls).toEqual([[`a1`]]);
        expect(board.agents.open).not.toHaveBeenCalled();
    });

    it(`composes a range of panes on Shift, from the last card clicked here, else from the chat's own`, () => {
        const board = boardOf([a1, a2, a3], { ...EMPTY_STRIP, active: `a3` });
        board.focus.focusAgent(a1, new MouseEvent(`click`, { shiftKey: true }));
        board.focus.focusAgent(a2, new MouseEvent(`click`));
        board.focus.focusAgent(a3, new MouseEvent(`click`, { shiftKey: true }));
        expect(board.summon.mock.calls).toEqual([
            [{ kind: `reveal`, verb: `panes`, entries: [tabOf(a1), tabOf(a2), tabOf(a3)], focus: `a1`, caret: false }],
            [{ kind: `reveal`, verb: `panes`, entries: [tabOf(a2), tabOf(a3)], focus: `a3`, caret: false }],
        ]);
    });

    it(`keeps a look, ends a card everywhere, and walks to a review keeping its chat`, () => {
        const board = boardOf([a1]);
        board.focus.keepAgent(a1);
        board.focus.closeAgent(a1);
        board.focus.reviewAgent(a1);
        expect(board.summon.mock.calls).toEqual([
            [{ kind: `keep`, conversationIds: [`a1`] }],
            [{ kind: `close`, conversationIds: [`a1`] }],
            [{ kind: `keep`, conversationIds: [`a1`] }],
        ]);
        expect(board.agents.open.mock.calls).toEqual([[a1]]);
        expect(board.push.mock.calls).toEqual([[`/agents/a1`]]);
    });

    it(`opens a conversation no card stands for as a fresh tab on its session`, () => {
        const board = boardOf([]);
        board.focus.openSession(`s1`);
        const summons = board.summon.mock.calls[0]![0] as Extract<Summons, { kind: `reveal` }>;
        expect(summons).toEqual({
            kind: `reveal`,
            verb: `show`,
            entries: [{ conversationId: expect.any(String), sessionRef: `s1`, title: `Old chat` }],
            focus: expect.any(String),
            caret: false,
        });
        // Focused on the tab it opens.
        expect(summons.focus).toBe((summons.entries[0] as { conversationId: string }).conversationId);
    });

    it(`scrolls to a card selected off the board, but not to one just clicked on it, and only that once`, async () => {
        const board = boardOf([a1, a2]);
        board.strip.value = { ...EMPTY_STRIP, active: `a2` };
        await nextTick();
        expect(board.reveal.mock.calls).toEqual([[`a2`]]);

        board.focus.focusAgent(a1, new MouseEvent(`click`));
        board.strip.value = { ...EMPTY_STRIP, active: `a1` };
        await nextTick();
        board.strip.value = { ...EMPTY_STRIP, active: `a2` };
        await nextTick();
        board.strip.value = { ...EMPTY_STRIP, active: `a1` };
        await nextTick();
        expect(board.reveal.mock.calls).toEqual([[`a2`], [`a2`], [`a1`]]);
    });
});

describe(`a link to a card`, () => {
    const linked = (roster: FleetAgent[], over: { mobile?: boolean; filtering?: boolean } = {}) => {
        const cards = shallowRef<FleetAgent[]>([]);
        const route = reactive({ query: { focus: `a9`, tab: `x` } as LocationQuery });
        const replace = jest.fn(async (_to: RouteLocationRaw) => undefined);
        const router = unstubbed<Router>(`router`, { replace });
        const open = jest.fn((_agent: FleetAgent, _mode?: `peek` | `keep`) => undefined);
        const move = jest.fn((_event: ViewEvent) => undefined);
        const reveal = jest.fn(async (_id: string) => undefined);
        const query = ref(`log`);
        const mobile = ref(over.mobile ?? false);
        const strip = shallowRef(EMPTY_STRIP);
        const ring = inScope(() => useCardRing({ mobile, strip, wide: ref(false), runs: shallowRef([]) }));
        inScope(() =>
            useCardFocus({
                ring,
                lanes: { paneOrder: shallowRef([]), finishedWindow: shallowRef({ shown: roster.slice(0, 1) }) },
                filter: { active: ref(over.filtering ?? false), matches: () => false, query, sessionMatches: shallowRef([]) },
                agents: { open, markSeen: () => undefined, agentById: (id: string) => cards.value.find((agent) => agent.id === id) },
                drag: { consumeSuppressedOpen: () => false },
                move,
                reveal,
                router,
                route,
                mobile,
                strip,
                summon: () => undefined,
            }),
        );
        const arrive = async (): Promise<void> => {
            cards.value = roster;
            await nextTick();
        };
        return { ring, open, move, reveal, replace, query, arrive };
    };

    it(`waits for its card, then strips itself from the address, opens and rings the card and scrolls to it`, async () => {
        const target = card(`a9`);
        const link = linked([card(`a1`), target]);
        await nextTick();
        expect(link.open).not.toHaveBeenCalled();

        await link.arrive();

        expect(link.replace.mock.calls).toEqual([[{ query: { focus: undefined, tab: `x` } }]]);
        expect(link.open.mock.calls).toEqual([[target]]);
        expect(link.ring.highlightId.value).toBe(`a9`);
        expect(link.reveal.mock.calls).toEqual([[`a9`], [`a9`]]);
        expect(link.move).not.toHaveBeenCalled();
        expect(link.query.value).toBe(`log`);
    });

    it(`clears a filter hiding the card, and opens the archive for an archived one`, async () => {
        const link = linked([card(`a9`, { archivedAt: 5 })], { filtering: true });
        await link.arrive();
        expect(link.query.value).toBe(``);
        expect(link.move.mock.calls).toEqual([[{ kind: `uncover`, into: `archive` }]]);
    });

    it(`opens the whole lane on a phone when the card is outside Finished's window, and leaves it be inside`, async () => {
        const outside = linked([card(`a1`), card(`a9`)], { mobile: true });
        await outside.arrive();
        expect(outside.move.mock.calls).toEqual([[{ kind: `uncover`, into: `lane` }]]);

        const inside = linked([card(`a9`)], { mobile: true });
        await inside.arrive();
        expect(inside.move).not.toHaveBeenCalled();
    });
});
