/* ONE CONVERSATION, FIVE SURFACES, ONE STORY. The chat's pick-up strip, its composer (what Send means, whether Stop
   stands in its slot), the board card's Send again / Send at reset, the tab's header glyph and the live line's ending all
   read one conversation's state, and they disagreed: a card in Finished beside a composer still offering a limit's
   Continue (2026-11-01, true-pine-bgzz), a composer reading idle over a turn the card said ran (2026-10-28,
   snug-condor-4nbi), a strip greyed under "awaiting reset" for a reset nobody knew beside an enabled Send again. Every
   card state the board can be handed (each status, each press the daemon states or none from an older one, each reset,
   a booked re-run or none) is read here with every window state (streaming or not, its own reading absent, the card's,
   another, or the card's resting after a refusal) and every reading of the account a press would run on, and the
   surfaces must agree by the rules each one's own comments state. */
import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import { type AgentPress, NO_PRESS } from "@intentic/sandbox-contract/schemas/agent-press";
import { AgentStatusSchema, type AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import type { TurnEnding } from "@intentic/sandbox-contract/events/transcript";
import type { AccountState } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { computed } from "vue";
import { NO_ATTENTION } from "../../agent-status/agentStatus-lanes";
import { agentStatusMeta } from "../../agent-status/agentStatus-meta";
import { type AgentStanding, limited, turnInFlight } from "../../agent-status/agentStatus-standing";
import { sendBlockOf } from "../../providers/sendAvailability";
import { spentUntilOf } from "../accounts/runServing";
import { LIMIT_COOLDOWN_MS, type PickUp, pickUpNext, pickUpOf, pickUpReady, pressOnlyStop, withCardBooking } from "../endings/pickUp";
import { cardPressWay, goesAtReopen, pressWayOf } from "../endings/pressWay";
import { Conversation } from "../session/conversation";
import { runningTurn } from "../../../testing/runningTurn";
import { type ComposerSituation, continueVisible, sendIntentOf } from "../../../features/chat/composer/composerIntent";
import { statusLookOf } from "../../../features/chat/tabs/statusLook";
import { conversationView } from "./useChat-view";

afterEach(() => resetSandboxScope());

const NOW = Date.now();
const S = (ms: number): number => Math.round(ms / 1_000);
const RESETS: readonly (readonly [string, number | undefined])[] = [
    [`ahead`, S(NOW + 2 * 3_600_000)],
    [`unknown`, undefined],
    [`past`, S(NOW - 60_000)],
];

type Card = AgentStanding & { readonly run?: string; readonly updatedAt?: number };

// Each press the daemon can state, by name, and the failure its card files beside it; `absent` is a sandbox older than
// the press, `none` one with nothing to press.
interface PressCase {
    readonly name: string;
    readonly press: AgentPress | undefined;
    readonly failureCode?: string;
}
const continuing = (ending: TurnEnding): AgentPress => ({ kind: `continue`, ending });
const pressCases = (resetsAt: number | undefined): readonly PressCase[] => {
    const limit = (held?: { readonly ran: boolean }): TurnEnding => {
        const ending: TurnEnding = resetsAt === undefined ? { reason: `limit` } : { reason: `limit`, resetsAt };
        return held === undefined ? ending : { ...ending, held };
    };
    return [
        { name: `absent`, press: undefined },
        { name: `none`, press: NO_PRESS },
        { name: `stopped`, press: continuing({ reason: `stopped` }) },
        { name: `stopped, held`, press: continuing({ reason: `stopped`, held: { ran: true } }) },
        { name: `stopped, press only`, press: continuing({ reason: `stopped`, held: { ran: true, pressOnly: true } }), failureCode: `turn-cap` },
        { name: `limit, unheld`, press: continuing(limit()), failureCode: `rate_limit` },
        { name: `limit, held ran`, press: continuing(limit({ ran: true })), failureCode: `rate_limit` },
        { name: `limit, held at the door`, press: continuing(limit({ ran: false })), failureCode: `rate_limit` },
        { name: `outage`, press: continuing({ reason: `outage` }), failureCode: `provider-outage` },
        { name: `flagged`, press: continuing({ reason: `flagged`, held: { ran: true } }), failureCode: `safeguard-flagged` },
    ];
};

const cardWith = (status: AgentStatus, pressCase: PressCase, resetsAt: number | undefined, rerun: boolean): Card => {
    let card: Card = { status, attention: NO_ATTENTION, run: `r-card`, updatedAt: 2_000 };
    if (pressCase.press !== undefined) {
        card = { ...card, press: pressCase.press };
    }
    if (pressCase.failureCode !== undefined) {
        card = { ...card, failureCode: pressCase.failureCode };
    }
    const ending = pressCase.press?.kind === `continue` ? pressCase.press.ending : undefined;
    if (ending?.reason === `limit`) {
        card = { ...card, limitHeld: ending.held !== undefined };
        if (resetsAt !== undefined) {
            card = { ...card, limitResetsAt: resetsAt };
        }
    }
    return rerun ? { ...card, next: { kind: `rerun`, at: NOW + 3 * 3_600_000 } } : card;
};

// What this window saw for itself, given the card: nothing, the card's own ending, another one, or the card's resting
// after a refusal where nothing ran.
const WINDOWS: readonly (readonly [string, (card: Card) => PickUp | undefined])[] = [
    [`nothing`, () => undefined],
    [`same`, (card) => (card.press?.kind === `continue` ? pickUpOf(card.press.ending) : { reason: `limit`, held: { ran: true } })],
    [`different`, (card) => ({ reason: card.press?.kind === `continue` && card.press.ending.reason === `outage` ? `stopped` : `outage` })],
    [
        `same, resting`,
        (card) => ({
            ...(card.press?.kind === `continue` ? pickUpOf(card.press.ending) : { reason: `limit` as const }),
            held: { ran: false },
            coolUntil: NOW + LIMIT_COOLDOWN_MS,
        }),
    ],
];

// The account the press would run on: nothing read, room, spent until the card's own reopen (or with none named), or
// signed out.
const accountsFor = (resetsAt: number | undefined): readonly (readonly [string, AccountState | undefined])[] => [
    [`none read`, undefined],
    [`ready`, { kind: `ready`, room: 40 }],
    [`spent`, resetsAt === undefined ? { kind: `spent` } : { kind: `spent`, reopensAt: resetsAt }],
    [`signed out`, { kind: `blocked`, fix: `reconnect`, reason: `signed out` }],
];

// The snapshot the composer builds over the view (composerSend.ts), an empty box on a connected chat.
const situationOf = (live: boolean, waitingOnYou: boolean, pickUp: PickUp | undefined, account: AccountState | undefined): ComposerSituation => {
    let atReopen: `book` | `arm` | undefined = `book`;
    if (pickUp?.reason === `flagged`) {
        atReopen = undefined;
    } else if (pickUp?.reason === `limit` && pickUp.held !== undefined) {
        atReopen = `arm`;
    }
    return {
        staged: false,
        attached: false,
        uploading: false,
        uploadFailed: false,
        voiceAgent: false,
        editing: false,
        pendingPlan: false,
        streaming: live,
        awaitingDecision: false,
        waitingOnYou,
        steerable: true,
        pickUp: pickUp === undefined ? undefined : { ready: pickUpReady(pickUp, NOW), atReopen },
        queued: 0,
        connected: true,
        spentUntil: spentUntilOf(account, NOW),
        accountBlock: sendBlockOf(account, NOW),
    };
};

// The card speaks of the press: it says one, and no turn of its is in flight (a land lease is none).
const speaks = (card: Card): boolean => card.press !== undefined && (!turnInFlight(card) || card.status === `landing`);

// One card state as one window reads it: the view a pane builds over the card (useChat-view.ts) and what it shows.
const windowOn = (card: Card, own: PickUp | undefined, streaming: boolean) => {
    const chat = new Conversation(`c1`);
    const view = conversationView(
        computed(() => chat),
        () => card,
        jest.fn((_: Conversation) => Promise.resolve()),
    );
    chat.pickUp.value = own;
    if (streaming) {
        runningTurn(chat.turn);
    }
    const ending = view.ending.value;
    return {
        shown: view.pickUp.value,
        ending,
        live: view.turnLive.value && ending === undefined,
        stoppable: view.turnStoppable.value && ending === undefined,
        // A turn runs here or where the card names its run, ended by a person or not: what keeps the strip away.
        turning: view.turnStoppable.value && (streaming || card?.run !== undefined),
        waitingOnYou: view.waitingOnYou.value,
        look: statusLookOf(chat, card),
    };
};
type WindowReading = ReturnType<typeof windowOn>;

// Every rule one card state, read in one window against one account reading, breaks, by name.
const brokenRules = (
    card: Card,
    own: PickUp | undefined,
    streaming: boolean,
    reading: WindowReading,
    account: AccountState | undefined,
): readonly string[] => {
    const { shown, ending, live, stoppable, turning, look } = reading;
    const situation = situationOf(live, reading.waitingOnYou, shown, account);
    const strip = continueVisible(situation);
    const intent = sendIntentOf(situation);
    const spentUntil = spentUntilOf(account, NOW);
    const way =
        shown === undefined
            ? undefined
            : pressWayOf({ pickUp: shown, state: account, spentUntil, accessWall: false, reachable: true, continuing: false, now: NOW });
    const cardWay = cardPressWay(card, NOW);
    const nobodyEnded = card.status === `running` || card.status === `resuming`;
    const midTurn = intent === `steer` || intent === `queue` || intent === `parked`;
    const said = card.press?.kind === `continue` ? card.press.ending : undefined;
    const rules: readonly (readonly [string, boolean])[] = [
        // The header is the card's word whenever there is a card (statusLook.ts).
        [`the header and the card apart`, look.label !== agentStatusMeta(card.status).label],
        // This window's own stream: nothing to pick up while the turn the strip was about is being replaced, and until a
        // person ends it (here or anywhere: the card's `stopping`), the composer takes words for it and Stop ends it.
        [`a strip over this window's own stream`, streaming && shown !== undefined],
        [`the composer idle over this window's own stream`, streaming && ending === undefined && !midTurn],
        [`no Stop over this window's own stream`, streaming && ending === undefined && !stoppable],
        [
            `a Stop made anywhere not shown over this window's own stream`,
            streaming && (card.status === `stopping` || card.status === `dismissing`) && ending !== card.status,
        ],
        // The card's word on the press, while it says one and no turn of its runs (useChat-view.ts pickUpView).
        [`a strip the card says nothing about`, !streaming && speaks(card) && card.press?.kind === `none` && shown !== undefined],
        [`no strip where the card says continue`, !streaming && speaks(card) && said !== undefined && shown === undefined],
        [
            `the strip's ending and the card's apart`,
            !streaming && speaks(card) && said !== undefined && (shown?.reason !== said.reason || shown.held?.ran !== said.held?.ran),
        ],
        [
            `the strip's press-only and the card's apart`,
            !streaming && speaks(card) && said !== undefined && (shown?.held?.pressOnly === true) !== (said.held?.pressOnly === true),
        ],
        // A sandbox older than the press leaves this window's own reading, timed by the card as before, but over a turn the
        // card says runs, beside whose Stop no Continue stands.
        [
            `an older card's strip not the window's own`,
            !streaming && !turning && card.press === undefined && JSON.stringify(shown) !== JSON.stringify(withCardBooking(own, card)),
        ],
        [`a strip beside a turn that runs`, turning && shown !== undefined],
        // A turn the card says runs, nobody having ended it: the composer takes words for it and the header spins; Stop ends
        // a run, never a resume, which has none (turn-doors.ts stopTurn).
        [`the composer idle over a turn the card says runs`, nobodyEnded && !midTurn],
        [`the header still over a turn the card says runs`, nobodyEnded && look.spin !== true],
        [`no Stop over a run the card says goes`, card.status === `running` && !stoppable],
        [`a Stop over a resume`, !streaming && card.status === `resuming` && stoppable],
        // A Stop or a dismissal made anywhere is the ending here too, and the composer reads the turn as over from it.
        [`a Stop made elsewhere not shown`, !streaming && (card.status === `stopping` || card.status === `dismissing`) && ending !== card.status],
        [`words for a turn already ended`, ending !== undefined && (midTurn || stoppable)],
        // A land is no turn: words sent then start their own, and nothing is there to stop.
        [`a land read as a turn`, !streaming && (card.status === `landing` || card.status === `landed`) && (live || stoppable)],
        // Shown, the strip always has a press that goes, or says why it rests (pressWay.ts).
        [`a strip whose press neither goes nor says why`, strip && way !== undefined && !way.enabled && way.rest === undefined],
        [`a rest nobody asked for`, way?.rest !== undefined && way.rest !== `cooling`],
        // A turn held for a press alone: nothing carries it on by itself, whatever the answer (pickUp.ts pressOnlyStop).
        [`a press-only stop that goes by itself`, shown !== undefined && pressOnlyStop(shown) && pickUpNext(shown, `retry`, NOW) !== undefined],
        // The board card's press and the strip's solid one go the same way for the same spent allowance (pressWay.ts).
        [`the card's press dead`, cardWay !== undefined && !cardWay.enabled],
        [
            `the card's Send at reset and the strip's reopen press apart`,
            !streaming &&
                speaks(card) &&
                limited(card) &&
                said?.reason === `limit` &&
                account?.kind === `spent` &&
                cardWay !== undefined &&
                way !== undefined &&
                goesAtReopen(cardWay) !== goesAtReopen(way),
        ],
    ];
    return rules.filter(([, broken]) => broken).map(([rule]) => rule);
};

// Every card state the board can be handed, with its name: each status, press, reset and booked re-run or none.
const everyCard = (): readonly { readonly name: string; readonly card: Card; readonly resetsAt: number | undefined }[] =>
    AgentStatusSchema.options.flatMap((status) =>
        RESETS.flatMap(([resetName, resetsAt]) =>
            pressCases(resetsAt).flatMap((pressCase) =>
                [false, true].map((rerun) => ({
                    name: `${status} / press ${pressCase.name} / reset ${resetName} / rerun=${rerun}`,
                    card: cardWith(status, pressCase, resetsAt, rerun),
                    resetsAt,
                })),
            ),
        ),
    );

describe(`every surface of one conversation`, () => {
    test(`tells one story, for every card, window and account`, () => {
        const wrong: string[] = [];
        let count = 0;
        const cards = everyCard();
        for (const { name, card, resetsAt } of cards) {
            const windows = WINDOWS.flatMap(([windowName, ownOf]) => [false, true].map((streaming) => ({ windowName, own: ownOf(card), streaming })));
            for (const { windowName, own, streaming } of windows) {
                const reading = windowOn(card, own, streaming);
                const accounts = accountsFor(resetsAt);
                count += accounts.length;
                const broken = accounts.flatMap(([accountName, account]) =>
                    brokenRules(card, own, streaming, reading, account).map((rule) => `${rule} [${accountName}]`),
                );
                if (broken.length > 0 && wrong.length < 16) {
                    wrong.push(`${name} / window ${windowName} / streaming=${streaming}: ${[...new Set(broken)].join(`; `)}`);
                }
            }
        }
        expect(wrong).toEqual([]);
        expect(cards.length).toBe(AgentStatusSchema.options.length * RESETS.length * 10 * 2);
        expect(count).toBe(cards.length * WINDOWS.length * 2 * 4);
        // Six thousand chats read four ways each: seconds alone, longer on a machine busy with other suites.
    }, 300_000);
});
