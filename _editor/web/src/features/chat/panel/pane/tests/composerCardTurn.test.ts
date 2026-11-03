import "@intentic/testing/dom";
import { resetSandboxScope } from "@intentic/extension-api";
import type { AgentStatus } from "@intentic/sandbox-contract/schemas/agents";
import { computed, createApp, h, ref, shallowRef } from "vue";
import { NO_ATTENTION } from "../../../../../models/agent-status/agentStatus-lanes";
import type { AgentStanding } from "../../../../../models/agent-status/agentStatus-standing";
import { providerAccounts } from "../../../../../models/providers/providerAccounts";
import { inputHistoryFor } from "../../../drafts/inputHistory";
import { Conversation } from "../../../../../models/conversations/session/conversation";
import { conversationView } from "../../../../../models/conversations/panel/useChat-view";
import { useComposerSend } from "../composerSend";
import { runningTurn } from "../../../../../testing/runningTurn";

// What one press of Send means while the board's card says a turn runs in this chat that this window follows no stream
// of yet: one another window or device started, a wake, a child's report, a booked send, the resume pass. The composer
// reads it as the live turn it is (steer or queue, and Stop in Send's slot), never as idle: on 2026-10-28
// (snug-condor-4nbi) it read idle over a running card, and the person's words went twice.

type Card = AgentStanding & { readonly run?: string; readonly updatedAt?: number };
const cardOf = (status: AgentStatus, run = `r-elsewhere`): Card => ({ status, attention: NO_ATTENTION, run, updatedAt: 2_000 });

let unmount: (() => void) | undefined;
// A pane's composer over a real conversation with Claude connected, its card whatever the case sets, and whether the
// running turn takes words in its own hands.
const composerOf = (initial?: Card) => {
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1`, label: `Claude`, connectedAt: 1 }] };
    const chat = new Conversation(`c1`);
    const card = shallowRef<Card | undefined>(initial);
    const steers = ref(true);
    const stopCard = jest.fn(() => Promise.resolve());
    const view = {
        ...conversationView(
            computed(() => chat),
            () => card.value,
            stopCard,
        ),
        steerable: computed(() => steers.value),
    };
    const say = jest.spyOn(chat.turn, `say`).mockResolvedValue(undefined);
    const host = {
        view,
        voiceAgent: ref(false),
        staging: { snapshot: () => [] },
        editorContext: { include: ref(false), forSend: () => undefined },
        runThrough: { clearFailures: jest.fn(), claimSend: jest.fn(() => false) },
        route: { beforeSend: jest.fn<(text: string, editorContext: boolean) => Promise<void> | undefined>(() => undefined) },
        history: shallowRef(inputHistoryFor(`sb-card-turn`)),
        reachable: ref(true),
        canDrive: ref(true),
        mobile: ref(false),
        words: computed(() => ({ provider: `Claude`, onTrial: false, editDropped: 0 })),
        pin: jest.fn(),
        refocus: jest.fn(),
        nudgeConnect: jest.fn(),
        armLimitResend: jest.fn(() => Promise.resolve()),
        limitArmed: ref(false),
        laterOffered: ref(false),
        titleOf: (): string | undefined => undefined,
    };
    let send: ReturnType<typeof useComposerSend> | undefined;
    const app = createApp({
        setup: () => {
            send = useComposerSend(host);
            return () => h(`div`);
        },
    });
    app.mount(document.createElement(`div`));
    unmount = () => app.unmount();
    return { chat, card, steers, stopCard, view, say, send: send! };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    inputHistoryFor(`sb-card-turn`).reset();
    resetSandboxScope();
});

describe(`a turn only the card says runs`, () => {
    it(`takes words for it, steered or queued as the turn allows, never as an idle send`, () => {
        const { chat, steers, send } = composerOf(cardOf(`running`));
        chat.draft.value = `and the footer`;

        expect(chat.turn.streaming.value).toBe(false);
        expect(send.intent.value).toBe(`steer`);
        steers.value = false;
        expect(send.intent.value).toBe(`queue`);
    });

    it(`offers Stop in Send's slot on an empty box, as for a turn this window follows`, () => {
        const { chat, send } = composerOf(cardOf(`running`));
        expect(send.sendShown.value).toBe(false);

        chat.draft.value = `and the footer`;
        expect(send.sendShown.value).toBe(true);
    });

    it(`sends the words through the one send path, which the daemon says into the turn or queues`, () => {
        const { chat, say, send } = composerOf(cardOf(`running`));
        chat.draft.value = `and the footer`;

        send.submit();

        expect(say.mock.calls).toEqual([[`and the footer`, [], undefined]]);
    });

    // Every standing the board counts as a turn in flight (turnInFlight), but a land, which is no turn.
    it(`reads each in-flight standing as live`, () => {
        const { card, send } = composerOf();
        card.value = cardOf(`running`);
        expect(send.intent.value).toBe(`steer`);
        // A resume is live too, its words waiting behind it rather than steering a run it has not started.
        card.value = cardOf(`resuming`);
        expect(send.intent.value).toBe(`queue`);
        for (const status of [`idle`, `stopped`, `error`, `landing`, `landed`] as const) {
            card.value = cardOf(status);
            expect(send.intent.value).toBe(`idle`);
        }
    });

    // A resume runs nothing until its re-run starts: words wait behind it (queue-waits.ts goesFirst), never steered into
    // it, and there is no run for a Stop to end (turn-doors.ts answers `stopped: false`), so Send keeps its slot, as on the
    // board's refused drop.
    it(`queues words behind a resume, and keeps Send in the slot, which has nothing for a Stop to end`, () => {
        const { chat, send } = composerOf(cardOf(`resuming`));

        expect(send.intent.value).toBe(`queue`);
        expect(send.sendShown.value).toBe(true);
        chat.draft.value = `and the footer`;
        expect(send.sendShown.value).toBe(true);
    });

    it(`is over from a Stop or a dismissal made anywhere: Send takes the slot back and the next words are the next turn's`, () => {
        const { card, view, send } = composerOf(cardOf(`running`));

        card.value = cardOf(`stopping`);
        expect(view.ending.value).toBe(`stopping`);
        expect(send.intent.value).toBe(`idle`);
        expect(send.sendShown.value).toBe(true);

        card.value = cardOf(`dismissing`);
        expect(view.ending.value).toBe(`dismissing`);
        expect(send.sendShown.value).toBe(true);
    });
});

describe(`what stays as it was`, () => {
    it(`a turn this window follows, whatever the card says`, () => {
        const { chat, card, steers, send } = composerOf(cardOf(`idle`));
        runningTurn(chat.turn);
        chat.draft.value = `and the footer`;

        expect(send.intent.value).toBe(`steer`);
        steers.value = false;
        expect(send.intent.value).toBe(`queue`);
        card.value = undefined;
        expect(send.intent.value).toBe(`queue`);
    });

    it(`a chat with no card, an unregistered draft: idle unless its own window streams`, () => {
        const { chat, send } = composerOf(undefined);
        chat.draft.value = `fix the footer`;
        expect(send.intent.value).toBe(`idle`);
        expect(send.sendShown.value).toBe(true);

        runningTurn(chat.turn);
        expect(send.intent.value).toBe(`steer`);
    });

    it(`an idle card with nothing streaming: an ordinary send`, () => {
        const { chat, say, send } = composerOf(cardOf(`idle`));
        chat.draft.value = `fix the footer`;

        expect(send.intent.value).toBe(`idle`);
        send.submit();
        expect(say).toHaveBeenCalledTimes(1);
    });
});
