import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentStatus, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { type AgentPress, NO_PRESS } from "@intentic/sandbox-contract/schemas/agent-press";
import type { TurnEnding } from "@intentic/sandbox-contract/events/transcript";
import { computed, shallowRef } from "vue";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import { type AgentStanding, turnInFlight } from "../../agent-status/agentStatus-standing";
import type { PickUp } from "../endings/pickUp";
import type { SandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { runningTurn } from "../../../testing/runningTurn";

// A chat's live turn as the board's card says it (ConversationView.turnLive, ending, stop): a turn another window, a
// wake or the resume pass started is live here before this window attaches to it, and its Stop goes the board's way.
// Regression 2026-10-28 (snug-condor-4nbi): the card said running, the composer read idle, and a message went twice.

const stop = jest.fn<SandboxRpc["agent"]["stop"]>();
const chooseHandoff = jest.fn<SandboxRpc["agent"]["chooseHandoff"]>();
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agent: { stop, chooseHandoff } }) }));

const { Conversation } = await import("../session/conversation");
const { conversationView } = await import("./useChat-view");
const { stopAgent } = await import("../../fleet/agentActions");
const { setAgents } = await import("../../fleet/useAgents-registry");
const { withCardBooking } = await import("../endings/pickUp");

type Card = AgentStanding & { readonly run?: string; readonly updatedAt?: number };
const cardOf = (status: AgentStatus, more: Partial<Card> = {}): Card => ({ status, attention: NO_ATTENTION, ...more });

// A view over a fresh chat, its card whatever the case sets, and the board's Stop caught.
const viewOf = (initial?: Card) => {
    const chat = new Conversation(`c1`);
    const card = shallowRef<Card | undefined>(initial);
    const stopCard = jest.fn((_: InstanceType<typeof Conversation>) => Promise.resolve());
    const view = conversationView(
        computed(() => chat),
        () => card.value,
        stopCard,
    );
    return { chat, card, stopCard, view };
};

afterEach(() => {
    stop.mockReset();
    chooseHandoff.mockReset();
    resetSandboxScope();
});

describe(`a turn the card says runs here`, () => {
    it(`is live before this window follows it, with nothing ended`, () => {
        const { view } = viewOf(cardOf(`running`, { run: `r-elsewhere` }));

        expect(view.streaming.value).toBe(false);
        expect(view.cardLive.value).toBe(true);
        expect(view.turnLive.value).toBe(true);
        expect(view.ending.value).toBeUndefined();
    });

    // A land is the board's in flight too, but no turn: words sent then start one of their own, and nothing is there to stop.
    it(`counts every standing the board counts as a turn in flight, and nothing else`, () => {
        const { card, view } = viewOf();
        for (const status of [`running`, `stopping`, `dismissing`, `resuming`] as const) {
            card.value = cardOf(status);
            expect(view.turnLive.value).toBe(true);
        }
        for (const status of [`idle`, `awaiting`, `stopped`, `error`, `interrupted`, `ready`, `landing`, `landed`, `conflict`] as const) {
            card.value = cardOf(status);
            expect(view.turnLive.value).toBe(false);
        }
    });

    it(`shows a Stop made anywhere as the ending`, () => {
        const { card, view } = viewOf(cardOf(`running`, { run: `r-elsewhere` }));

        card.value = cardOf(`stopping`, { run: `r-elsewhere` });
        expect(view.ending.value).toBe(`stopping`);
        card.value = cardOf(`dismissing`, { run: `r-elsewhere` });
        expect(view.ending.value).toBe(`dismissing`);
    });

    // A resume is no run: the daemon holds the turn for its re-run with nothing running (conversation-status.ts), so a Stop
    // finds nothing to end (turn-doors.ts stopTurn answers `stopped: false`) and the board refuses one there ("picking
    // back up", laneDrop.ts). The words typed meanwhile still wait behind it (queue-waits.ts goesFirst), so it is live.
    it(`offers no Stop over a resume, which runs nothing a Stop could end, while its words still wait behind it`, () => {
        const { chat, stopCard, view } = viewOf(cardOf(`resuming`, { run: `r-before` }));
        const own = jest.spyOn(chat.turn, `stop`);

        expect(view.turnLive.value).toBe(true);
        expect(view.turnStoppable.value).toBe(false);
        view.stop();

        expect(stopCard).not.toHaveBeenCalled();
        expect(own).toHaveBeenCalledTimes(1);
        // Every other standing a turn runs in is stopped as the board stops it.
        const { view: running } = viewOf(cardOf(`running`, { run: `r-elsewhere` }));
        expect(running.turnStoppable.value).toBe(true);
    });

    it(`is stopped the board's way, by the card's run, and never by this window's own path`, () => {
        const { chat, stopCard, view } = viewOf(cardOf(`running`, { run: `r-elsewhere` }));
        const own = jest.spyOn(chat.turn, `stop`);

        view.stop();

        expect(stopCard.mock.calls).toEqual([[chat]]);
        expect(own).not.toHaveBeenCalled();
    });
});

describe(`a turn this window follows`, () => {
    it(`reads as it always did when the card says nothing runs`, () => {
        const { chat, view } = viewOf(cardOf(`idle`));
        runningTurn(chat.turn);

        expect(view.cardLive.value).toBe(false);
        expect(view.turnLive.value).toBe(true);
        expect(view.ending.value).toBeUndefined();
    });

    it(`stops by its own path, whatever the card says`, () => {
        const { chat, stopCard, view } = viewOf(cardOf(`running`, { run: `run-1` }));
        const own = jest.spyOn(chat.turn, `stop`).mockReturnValue(undefined);
        runningTurn(chat.turn);

        view.stop();

        expect(own).toHaveBeenCalledTimes(1);
        expect(stopCard).not.toHaveBeenCalled();
    });

    // The roster settles a moment after the stream closes: a card still naming the run this window saw end is the roster
    // catching up, not a turn this window lost, so the composer does not flash Stop after every turn.
    it(`is over once its stream closes, while the card only repeats what it said of that run`, () => {
        const { chat, card, view } = viewOf(cardOf(`running`, { run: `run-1`, updatedAt: 5_000 }));
        runningTurn(chat.turn, 4_000, `run-1`);
        chat.turn.phase.value = { kind: `idle`, accepted: true };

        expect(view.turnLive.value).toBe(false);
        card.value = cardOf(`stopping`, { run: `run-1`, updatedAt: 5_000 });
        expect(view.ending.value).toBeUndefined();

        // The same run moving on (its stream lost, not ended) is the card's word again, as is a run of its own.
        card.value = cardOf(`running`, { run: `run-1`, updatedAt: 6_000 });
        expect(view.turnLive.value).toBe(true);
        card.value = cardOf(`running`, { run: `run-2`, updatedAt: 5_000 });
        expect(view.turnLive.value).toBe(true);
    });
});

describe(`a chat with no card`, () => {
    it(`reads only what its own window saw, an unregistered draft included`, () => {
        const { chat, view } = viewOf(undefined);
        expect(view.turnLive.value).toBe(false);
        expect(view.ending.value).toBeUndefined();

        runningTurn(chat.turn);
        expect(view.turnLive.value).toBe(true);
    });

    it(`stops by this window's own path, a view handed no fleet included`, () => {
        const chat = new Conversation(`c1`);
        const view = conversationView(computed(() => chat));
        const own = jest.spyOn(chat.turn, `stop`).mockReturnValue(undefined);

        view.stop();

        expect(own).toHaveBeenCalledTimes(1);
        expect(view.turnLive.value).toBe(false);
    });
});

// The pane's Stop is the board's own (agentActions.stopAgent): it names the run the card shows, so one landing after
// that turn ended cannot cancel whatever the conversation started next.
describe(`the board's Stop, from the chat`, () => {
    const running: AgentSummary = {
        id: `c1`,
        title: `Fix the parser`,
        provider: `claude`,
        harness: `native`,
        status: `running`,
        run: `r-elsewhere`,
        updatedAt: 2_000,
        attention: NO_ATTENTION,
    };

    it(`posts a stop naming the card's run when this window follows no stream of it`, async () => {
        stop.mockResolvedValue({ stopped: true });
        setAgents([running], 1);
        const chat = new Conversation(`c1`);
        const view = conversationView(
            computed(() => chat),
            () => running,
            (stopped) => stopAgent(stopped.conversationId, stopped.box.value),
        );

        view.stop();

        await new Promise((settle) => setTimeout(settle, 0));
        expect(stop.mock.calls.map(([input]) => input)).toEqual([{ conversationId: `c1`, run: `r-elsewhere` }]);
    });
});

/* THE STRIP'S PICK-UP, THE CARD'S FIRST (pickUpView). The daemon states what a press does on the card (AgentSummary.press);
   while it says so and no turn of its runs, the strip follows it over this window's own reading, keeping only this
   window's rest after a refusal. A card that says nothing of it (an older sandbox, a draft's), or one whose turn is
   under way, leaves this window's reading, timed by the card as before. Regressions: 2026-11-01 (true-pine-bgzz), the
   card in Finished while the composer still said "Limit reached, work kept"; a reloaded window with no strip at all. */
describe(`the strip's pick-up`, () => {
    const RESET = Math.floor(Date.now() / 1_000) + 3_600;
    const COOL = Date.now() + 60_000;
    const limitEnding = (held?: { readonly ran: boolean }): TurnEnding => (held === undefined ? { reason: `limit`, resetsAt: RESET } : { reason: `limit`, resetsAt: RESET, held });
    const continuing = (ending: TurnEnding): AgentPress => ({ kind: `continue`, ending });
    const limitCard = (status: AgentStatus, held: boolean, press?: AgentPress): Card => {
        const card = cardOf(status, { failureCode: `rate_limit`, limitResetsAt: RESET, limitHeld: held });
        return press === undefined ? card : { ...card, press };
    };

    // Every card a pane can be handed: none, one with nothing to press, one per ending a press carries on, one from a
    // sandbox that never says, and one whose turn is in flight (the press it carries then is not the word).
    const CARDS: ReadonlyMap<string, Card | undefined> = new Map<string, Card | undefined>([
        [`no card`, undefined],
        [`press none, finished`, cardOf(`idle`, { press: NO_PRESS })],
        [`press none, a failure to repair`, cardOf(`error`, { failureCode: `agent-busy`, press: NO_PRESS })],
        [`continue stopped`, cardOf(`stopped`, { press: continuing({ reason: `stopped` }) })],
        [`continue stopped, press only`, cardOf(`error`, { failureCode: `turn-cap`, press: continuing({ reason: `stopped`, held: { ran: true, pressOnly: true } }) })],
        [`continue limit, held`, limitCard(`error`, true, continuing(limitEnding({ ran: true })))],
        [`continue limit, unheld`, limitCard(`error`, false, continuing(limitEnding()))],
        [`continue outage`, cardOf(`error`, { failureCode: `provider-outage`, press: continuing({ reason: `outage` }) })],
        [`continue flagged`, cardOf(`error`, { failureCode: `safeguard-flagged`, press: continuing({ reason: `flagged`, held: { ran: true } }) })],
        [`without press`, limitCard(`error`, true)],
        [`in flight, saying none`, cardOf(`running`, { run: `r-elsewhere`, press: NO_PRESS })],
        [`in flight, a stale continue`, cardOf(`resuming`, { press: continuing({ reason: `stopped` }) })],
        // A land lease is no turn (liveView's cardLive): the card's word on the press stands through it.
        [`landing, saying none`, cardOf(`landing`, { press: NO_PRESS })],
    ]);
    // What this window saw for itself: nothing, the card's own wall, another wall, or the card's wall resting after a
    // refusal where nothing ran.
    const WINDOWS: ReadonlyMap<string, (card: Card | undefined) => PickUp | undefined> = new Map<string, (card: Card | undefined) => PickUp | undefined>([
        [`nothing`, () => undefined],
        [`same`, (card) => ({ reason: card?.press?.kind === `continue` ? card.press.ending.reason : `limit`, held: { ran: false } })],
        [`different`, (card) => ({ reason: card?.press?.kind === `continue` && card.press.ending.reason === `outage` ? `stopped` : `outage` })],
        [`same, cooling`, (card) => ({ reason: card?.press?.kind === `continue` ? card.press.ending.reason : `limit`, held: { ran: false }, coolUntil: COOL })],
    ]);

    // The card is the word while it says and no turn of it runs (a land lease is none).
    const speaks = (card: Card | undefined): card is Card & { readonly press: AgentPress } =>
        card?.press !== undefined && (!turnInFlight(card) || card.status === `landing`);

    test(`follows the card wherever it says, and this window's own reading elsewhere`, () => {
        const wrong: string[] = [];
        for (const [cardName, card] of CARDS) {
            for (const [windowName, windowOf] of WINDOWS) {
                for (const streaming of [false, true]) {
                    const { chat, view } = viewOf(card);
                    const own = windowOf(card);
                    chat.pickUp.value = own;
                    if (streaming) {
                        runningTurn(chat.turn);
                    }
                    const shown = view.pickUp.value;
                    const name = `${cardName} / window ${windowName} / streaming=${streaming}`;
                    if (streaming) {
                        // While this window streams, nothing: the turn the strip was about is being replaced.
                        wrong.push(...(shown === undefined ? [] : [`${name}: shown while streaming`]));
                        continue;
                    }
                    // A turn the card names running (not a resume, which runs nothing yet): nothing stopped short while it does.
                    if (view.turnStoppable.value && card?.run !== undefined) {
                        wrong.push(...(shown === undefined ? [] : [`${name}: a strip beside a turn the card says runs`]));
                        continue;
                    }
                    if (!speaks(card)) {
                        const expected = withCardBooking(own, card);
                        wrong.push(...(JSON.stringify(shown) === JSON.stringify(expected) ? [] : [`${name}: ${JSON.stringify(shown)} != window's ${JSON.stringify(expected)}`]));
                        continue;
                    }
                    if (card.press.kind === `none`) {
                        wrong.push(...(shown === undefined ? [] : [`${name}: a strip the card says nothing about`]));
                        continue;
                    }
                    const { ending } = card.press;
                    const rests = own?.coolUntil !== undefined && own.reason === ending.reason;
                    const problems = [
                        ...(shown?.reason === ending.reason ? [] : [`reason ${shown?.reason}`]),
                        ...(JSON.stringify(shown?.held) === JSON.stringify(ending.held) ? [] : [`held ${JSON.stringify(shown?.held)}`]),
                        ...(shown?.coolUntil === (rests ? COOL : undefined) ? [] : [`coolUntil ${shown?.coolUntil}`]),
                    ];
                    wrong.push(...problems.map((problem) => `${name}: ${problem}`));
                }
            }
        }
        expect(wrong).toEqual([]);
    });

    // 2026-11-01, true-pine-bgzz: the card had moved on to Finished, and the composer still offered the limit's Continue.
    it(`shows no strip where the card says nothing is to press, whatever this window saw`, () => {
        const { chat, view } = viewOf(cardOf(`idle`, { press: NO_PRESS }));
        chat.pickUp.value = { reason: `limit`, readyAt: Date.now() + 3_600_000, held: { ran: true } };

        expect(view.pickUp.value).toBeUndefined();
    });

    // A window reloaded after the refusal saw no frame: the card's held turn is the strip, and the press re-runs it.
    it(`shows the card's held turn to a window that saw nothing, and re-runs it on the press`, async () => {
        const { chat, view } = viewOf(limitCard(`error`, true, continuing(limitEnding({ ran: true }))));
        const rerun = jest.spyOn(chat.turn, `resumeHeldTurn`).mockResolvedValue(true);
        expect(chat.pickUp.value).toBeUndefined();

        expect(view.pickUp.value).toEqual({ reason: `limit`, readyAt: RESET * 1_000, held: { ran: true } });
        await view.continueTurn();

        expect(rerun).toHaveBeenCalledWith({}, { pickUp: { reason: `limit`, readyAt: RESET * 1_000, held: { ran: true } } });
    });

    // The card's booking still times the strip: the daemon re-booked the held turn, and only the card heard it.
    it(`states the card's booking and move on the held turn it says`, () => {
        const booked = { ...limitCard(`error`, true, continuing({ ...limitEnding({ ran: true }), scheduled: true })), next: { kind: `rerun`, at: RESET * 1_000 + 30_000, onto: `acct-2` } } as const;
        const { view } = viewOf(booked);

        expect(view.pickUp.value).toEqual({ reason: `limit`, readyAt: RESET * 1_000, booked: true, nextAt: RESET * 1_000 + 30_000, held: { ran: true, moving: `acct-2` } });
    });

    it(`keeps this window's rest after a refusal on the card's same wall, and drops it on another`, () => {
        const { chat, card, view } = viewOf(limitCard(`error`, true, continuing(limitEnding({ ran: false }))));
        chat.pickUp.value = { reason: `limit`, held: { ran: false }, coolUntil: COOL };
        expect(view.pickUp.value?.coolUntil).toBe(COOL);

        card.value = cardOf(`stopped`, { press: continuing({ reason: `stopped` }) });
        expect(view.pickUp.value).toEqual({ reason: `stopped` });
    });

    // The hand-off pick is a press on the turn the strip shows: a window that never saw the frame (reloaded, or whose own
    // reading is of an older ending) still sends it, rather than dropping it for want of its own copy of the hold.
    it(`sends the hand-off picked on the card's held turn, from a window whose own reading is not it`, async () => {
        const handoff = { suggested: `trim`, basis: `size`, carry: { tokens: 180_000 }, trim: { tokens: 40_000, cleared: 12 } } as const;
        const ending: TurnEnding = { reason: `limit`, resetsAt: RESET, held: { ran: true, handoff } };
        chooseHandoff.mockResolvedValue({ ok: true });
        for (const own of [undefined, { reason: `stopped` } as const]) {
            const { chat, view } = viewOf(limitCard(`error`, true, continuing(ending)));
            chat.registered.value = true;
            chat.pickUp.value = own;
            expect(view.pickUp.value?.held?.handoff).toEqual(handoff);

            await expect(view.chooseHandoff(`summary`)).resolves.toBe(true);
        }
        expect(chooseHandoff.mock.calls.map(([input]) => input)).toEqual([
            { conversationId: `c1`, handoff: `summary` },
            { conversationId: `c1`, handoff: `summary` },
        ]);
    });

    // The roster can settle before this window's stream closes, and the card it then said stays the same run at the same
    // instant while the sandbox re-times the hold, moves it, or fires it: the strip still reads the card's booking then,
    // as it did before the card had a press (withCardBooking), so the chat says when it goes as the board does.
    it(`follows the card's re-timed hold after this window's own stream of the turn closed`, () => {
        const settled = (resetsAt: number): Card => ({
            ...limitCard(`error`, true, continuing({ reason: `limit`, resetsAt, held: { ran: true } })),
            limitResetsAt: resetsAt,
            run: `run-1`,
            updatedAt: 5_000,
        });
        const { chat, card, view } = viewOf(settled(RESET));
        runningTurn(chat.turn, 4_000, `run-1`);
        chat.pickUp.value = { reason: `limit`, readyAt: RESET * 1_000, held: { ran: true } };
        chat.turn.phase.value = { kind: `idle`, accepted: true };

        card.value = settled(RESET + 1_800);

        expect(view.pickUp.value?.readyAt).toBe((RESET + 1_800) * 1_000);
        // Its liveness is still the card's catching up, never a turn this window lost.
        expect(view.turnLive.value).toBe(false);
    });

    // Another window's turn, a wake, the sandbox's own re-run once started: while a turn runs nothing has stopped short,
    // and an ending this window still held stood its Continue beside the Stop until this window attached.
    it(`shows no strip while the card says a turn runs that this window does not follow`, () => {
        const own: PickUp = { reason: `stopped`, held: { ran: true } };
        const { chat, card, view } = viewOf(cardOf(`running`, { run: `r-elsewhere`, press: NO_PRESS }));
        chat.pickUp.value = own;
        for (const status of [`running`, `stopping`, `dismissing`] as const) {
            card.value = cardOf(status, { run: `r-elsewhere`, press: NO_PRESS });
            expect([status, view.pickUp.value]).toEqual([status, undefined]);
        }
        // A resume runs nothing yet: its strip says how the turn ended and what brings it back.
        card.value = cardOf(`resuming`, { press: NO_PRESS });
        expect(view.pickUp.value).toEqual(own);
    });

    // A card whose turn runs is no word on what a press does after it; nor is one from a sandbox that never says.
    it(`reads this window's own pick-up while the card's turn is in flight, or the card never says`, () => {
        const own: PickUp = { reason: `stopped`, held: { ran: true } };
        const { chat, card, view } = viewOf(cardOf(`resuming`, { press: NO_PRESS }));
        chat.pickUp.value = own;
        expect(view.pickUp.value).toEqual(own);

        card.value = cardOf(`error`);
        expect(view.pickUp.value).toEqual(own);

        // Once it lands and says, it is the word.
        card.value = cardOf(`error`, { press: NO_PRESS });
        expect(view.pickUp.value).toBeUndefined();
    });
});
