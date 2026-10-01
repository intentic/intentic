import "@intentic/testing/dom";
import { STATE_DIR } from "@intentic/constants";
import { resetSandboxScope } from "@intentic/extension-api";
import { useT } from "@intentic/ui/i18n";
import { computed, createApp, h, nextTick, ref, shallowRef } from "vue";
import { providerAccounts } from "../../../accounts/providerAccounts";
import { viewerPlaceholder } from "../../../composer/composerIntent";
import { inputHistoryFor } from "../../../drafts/inputHistory";
import type { PendingAttachment } from "../../../drafts/useChatAttachments";
import { Conversation } from "../../../session/conversation";
import type { ChatMessage } from "../../../transcript/transcript";
import { conversationView } from "../../useChat-view";
import { useComposerSend } from "../composerSend";
import { runningTurn } from "../../../../../testing/runningTurn";

// Pins what one press of Send does, in the order the intents are named: speak as the agent, spend an armed edit, the
// run-through badge, Continue, a plan's rejection, a message; and what the composer says about it on the way.

const CHIP: PendingAttachment = { id: `u1`, name: `shot.png`, path: `${STATE_DIR}/a/shot.png`, status: `done`, progress: 100 };
const t = useT();

let unmount: (() => void) | undefined;
// A pane's composer over a real conversation whose sends are caught at the turn; Claude connected, so it can send.
const composerOf = (spentReopensAt?: number) => {
    providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `a1`, label: `Claude`, connectedAt: 1 }] };
    const chat = new Conversation(`c1`);
    // The account's verdict is the selection's to read (servingState); a test states the answer rather than a usage feed.
    const view = { ...conversationView(computed(() => chat)), spentReopensAt: computed(() => spentReopensAt) };
    const say = jest.spyOn(chat.turn, `say`).mockResolvedValue(undefined);
    const host = {
        view,
        voiceAgent: ref(false),
        staging: { snapshot: () => view.attachments.value.map(({ name, path }) => ({ name, path })) },
        editorContext: { include: ref(true), forSend: () => undefined },
        runThrough: { clearFailures: jest.fn(), claimSend: jest.fn(() => false) },
        route: { beforeSend: jest.fn<(text: string, editorContext: boolean) => Promise<void> | undefined>(() => undefined) },
        history: shallowRef(inputHistoryFor(`sb-send`)),
        reachable: ref(true),
        canDrive: ref(true),
        mobile: ref(false),
        words: computed(() => ({ provider: `Claude`, onTrial: false, editDropped: 0 })),
        pin: jest.fn(),
        refocus: jest.fn(),
        openModels: jest.fn(),
        armLimitResend: jest.fn(() => Promise.resolve()),
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
    return { chat, view, host, say, send: send! };
};

afterEach(() => {
    unmount?.();
    unmount = undefined;
    inputHistoryFor(`sb-send`).reset();
    resetSandboxScope();
});

describe(`a scheduled send`, () => {
    // Half a minute short of the half hour, so the label's round-up lands on 30 whichever way the seconds fell.
    const inHalfAnHour = (): number => Math.round(Date.now() / 1_000) + 1_770;

    it(`is booked for the reopen rather than tried now, with the limit answer set for a reopen named too early`, () => {
        const reopens = inHalfAnHour();
        const { chat, host, say, send } = composerOf(reopens);
        const schedule = jest.spyOn(chat.turn, `schedule`).mockResolvedValue(undefined);
        chat.draft.value = `ship it`;

        expect(send.intent.value).toBe(`scheduled`);
        expect(send.scheduledLabel.value).toBe(`30m`);
        send.submit();

        expect(host.armLimitResend).toHaveBeenCalledTimes(1);
        expect(schedule.mock.calls).toEqual([[`ship it`, reopens * 1_000, [], undefined]]);
        expect(say).not.toHaveBeenCalled();
        // The box is spent as for any send: the words now wait in the queue.
        expect(chat.draft.value).toBe(``);
    });

    it(`does not let a scheduled queue go on an empty press: the button reads as a time, not as now`, () => {
        const { chat, say, send } = composerOf(inHalfAnHour());
        chat.queue.value = {
            items: [{ id: `m1`, text: `ship it`, voice: `person`, queuedAt: 1, revision: 1 }],
            revision: 1,
            paused: `scheduled`,
            until: Date.now() + 60_000,
        };

        expect(send.canSend.value).toBe(false);
        send.submit();
        expect(say).not.toHaveBeenCalled();
    });

    it(`leaves its time-labelled button shut on an empty box; Enter continues as the strip's Continue does`, () => {
        const { chat, host, say, send } = composerOf(inHalfAnHour());
        const continued = jest.spyOn(chat.turn, `continueTurn`).mockResolvedValue(undefined);
        chat.pickUp.value = { reason: `limit`, readyAt: Date.now() + 60_000, held: { ran: true } };

        expect(send.intent.value).toBe(`scheduled`);
        expect(send.continueOffer.value).toBe(true);
        expect(send.canSend.value).toBe(false);
        send.submit();

        expect(continued).toHaveBeenCalledTimes(1);
        // The strip's Wait for me / Send again is the reader's to set; a Continue never flips it.
        expect(host.armLimitResend).not.toHaveBeenCalled();
        expect(say).not.toHaveBeenCalled();
    });

    it(`sends without arming anything when the caller has just made room itself`, () => {
        const { chat, host, say, send } = composerOf(inHalfAnHour());
        chat.draft.value = `ship it`;

        send.submit({ now: true });

        expect(host.armLimitResend).not.toHaveBeenCalled();
        expect(say).toHaveBeenCalledTimes(1);
    });

    it(`is a plain send once the named reset has passed: the reading is stale, not the account`, () => {
        const { chat, host, send } = composerOf(Math.round(Date.now() / 1_000) - 60);
        chat.draft.value = `ship it`;

        expect(send.intent.value).toBe(`idle`);
        expect(send.scheduledLabel.value).toBeUndefined();
        send.submit();
        expect(host.armLimitResend).not.toHaveBeenCalled();
    });
});

describe(`a message`, () => {
    it(`goes with its chips, and the box is spent: cleared, recalled, followed, refocused`, async () => {
        const { chat, host, say, send } = composerOf();
        chat.draft.value = `  fix the header `;
        chat.attachments.value = [CHIP];

        send.submit();

        expect(say.mock.calls).toEqual([[`fix the header`, [{ name: `shot.png`, path: `${STATE_DIR}/a/shot.png` }], undefined]]);
        expect(chat.draft.value).toBe(``);
        expect(chat.attachments.value).toEqual([]);
        expect(host.editorContext.include.value).toBe(false);
        expect(host.history.value.previous(``)).toBe(`fix the header`);
        expect(host.pin).toHaveBeenCalledTimes(1);
        await nextTick();
        expect(host.refocus).toHaveBeenCalledTimes(1);
    });

    it(`waits for a routed chat's one reading before it goes`, async () => {
        const { chat, host, say, send } = composerOf();
        let read = (): void => undefined;
        host.route.beforeSend.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    read = resolve;
                }),
        );
        chat.draft.value = `the invoice totals are off`;

        send.submit();
        expect(say).not.toHaveBeenCalled();
        expect(host.route.beforeSend.mock.calls).toEqual([[`the invoice totals are off`, true]]);

        read();
        await Promise.resolve();
        expect(say.mock.calls).toEqual([[`the invoice totals are off`, [], undefined]]);
    });

    it(`rejects a pending plan with the words as its feedback, files as @-paths`, () => {
        const { chat, say, send } = composerOf();
        const rows: ChatMessage[] = [
            { id: 1, role: `user`, text: `plan it` },
            { id: 2, role: `assistant`, text: ``, plan: { requestId: `d1`, text: `the plan`, status: `pending` } },
        ];
        chat.transcript.adopt(rows);
        const reply = jest.spyOn(chat.requests, `reply`).mockResolvedValue(true);
        chat.draft.value = `not like that`;
        chat.attachments.value = [CHIP];

        send.submit();

        expect(reply.mock.calls).toEqual([[`d1`, { kind: `plan`, approve: false, feedback: `not like that\n@.intentic/a/shot.png` }]]);
        expect(say).not.toHaveBeenCalled();
        expect(chat.attachments.value).toEqual([]);
    });
});

// Typed replies like "Proceed…" read as approval to the person and as a rejection to the turn, which then sat 16 minutes
// in plan mode: the bar's Approve takes the notes with it, and Send (keep planning) says so on its face.
describe(`a plan waiting on an answer`, () => {
    const withPlan = () => {
        const composer = composerOf();
        composer.chat.transcript.adopt([
            { id: 1, role: `user`, text: `plan it` },
            { id: 2, role: `assistant`, text: ``, plan: { requestId: `d1`, text: `# Ship the importer`, status: `pending` } },
        ]);
        return composer;
    };

    it(`says typing keeps it planning`, () => {
        const { send } = withPlan();

        expect(send.intent.value).toBe(`plan`);
        expect(send.composerPlaceholder.value).toBe(`Write notes to keep planning, or approve above…`);
    });

    it(`approves with the notes in the box, which follow the approval as a message`, async () => {
        const { chat, say, send } = withPlan();
        const reply = jest.spyOn(chat.requests, `reply`).mockResolvedValue(true);
        chat.draft.value = `use the v2 endpoint`;
        chat.attachments.value = [CHIP];

        await send.approvePlan();

        expect(reply.mock.calls).toEqual([[`d1`, { kind: `plan`, approve: true }]]);
        expect(say.mock.calls).toEqual([[`use the v2 endpoint`, [{ name: `shot.png`, path: CHIP.path }], undefined]]);
        expect(chat.draft.value).toBe(``);
        expect(chat.attachments.value).toEqual([]);
    });

    it(`approves alone with an empty box, and gives the notes back when the approval did not land`, async () => {
        const { chat, say, send } = withPlan();
        const reply = jest.spyOn(chat.requests, `reply`).mockResolvedValueOnce(true).mockResolvedValueOnce(false);

        await send.approvePlan();
        chat.draft.value = `use the v2 endpoint`;
        chat.attachments.value = [CHIP];
        await send.approvePlan();

        expect(reply.mock.calls).toEqual([
            [`d1`, { kind: `plan`, approve: true }],
            [`d1`, { kind: `plan`, approve: true }],
        ]);
        expect(say).not.toHaveBeenCalled();
        expect(chat.draft.value).toBe(`use the v2 endpoint`);
        expect(chat.attachments.value).toEqual([CHIP]);
    });

    it(`keeps planning with the box's notes as feedback, or a bare no when the box is empty`, () => {
        const { chat, send } = withPlan();
        const reply = jest.spyOn(chat.requests, `reply`).mockResolvedValue(true);

        send.keepPlanning();
        chat.draft.value = `smaller steps`;
        send.keepPlanning();

        expect(reply.mock.calls).toEqual([
            [`d1`, { kind: `plan`, approve: false }],
            [`d1`, { kind: `plan`, approve: false, feedback: `smaller steps` }],
        ]);
    });
});

describe(`what intercepts a press`, () => {
    it(`places the words as the agent's when the voice is armed, and keeps them when the place is refused`, async () => {
        const { chat, host, say, send } = composerOf();
        const place = jest.spyOn(chat.transcript, `placeAsAgent`).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
        host.voiceAgent.value = true;
        chat.draft.value = `I checked the tests.`;

        send.submit();
        await Promise.resolve();
        expect(chat.draft.value).toBe(`I checked the tests.`);
        expect(host.voiceAgent.value).toBe(true);

        send.submit();
        await Promise.resolve();
        await Promise.resolve();
        expect(place.mock.calls).toEqual([[`I checked the tests.`], [`I checked the tests.`]]);
        expect(chat.draft.value).toBe(``);
        // Speaking as the agent is a deliberate act each time.
        expect(host.voiceAgent.value).toBe(false);
        expect(say).not.toHaveBeenCalled();
    });

    it(`spends an armed edit in place of a message`, () => {
        const { chat, say, send } = composerOf();
        const rows: ChatMessage[] = [{ id: 1, role: `user`, text: `first`, rewindIndex: 0 }];
        chat.transcript.adopt(rows);
        chat.transcript.beginEdit(chat.transcript.messages.value[0]!);
        const submitEdit = jest.spyOn(chat.transcript, `submitEdit`).mockResolvedValue(true);
        chat.draft.value = `first, better`;

        send.submit();

        expect(submitEdit.mock.calls).toEqual([[`first, better`, [], undefined]]);
        expect(say).not.toHaveBeenCalled();
    });

    it(`lets a run-through badge take the press, and sends nothing of its own`, () => {
        const { chat, host, say, send } = composerOf();
        host.runThrough.claimSend.mockReturnValueOnce(true);
        chat.draft.value = `ship it`;

        send.submit();

        expect(host.runThrough.clearFailures).toHaveBeenCalledTimes(1);
        expect(say).not.toHaveBeenCalled();
        expect(chat.draft.value).toBe(`ship it`);
    });

    it(`opens the model list when nothing could answer, keeping the words for the model chosen`, () => {
        const { chat, host, say, send } = composerOf();
        providerAccounts.value = { ...providerAccounts.value, claude: [] };
        chat.draft.value = `hello`;

        send.submit();

        expect(host.openModels).toHaveBeenCalledTimes(1);
        expect(say).not.toHaveBeenCalled();
        expect(chat.draft.value).toBe(`hello`);
    });

    it(`does nothing while the sandbox can't be reached`, () => {
        const { chat, host, say, send } = composerOf();
        host.reachable.value = false;
        chat.draft.value = `hello`;

        send.submit();

        expect(say).not.toHaveBeenCalled();
        expect(chat.draft.value).toBe(`hello`);
        expect(send.sendHint.value).toEqual({ title: t(`chat.chatPane.sandboxBusy`), tone: `warn`, note: t(`chat.chatPane.keepTyping`) });
    });

    it(`continues a stopped turn when nothing is typed, recalling only what it sent`, async () => {
        const { chat, host, send } = composerOf();
        chat.pickUp.value = { reason: `stopped` };
        const continued = jest.spyOn(chat.turn, `continueTurn`).mockResolvedValue(`Continue`);
        expect(send.continueStrip.value).toBe(true);
        expect(send.continueOffer.value).toBe(true);

        send.submit();
        await Promise.resolve();

        expect(continued).toHaveBeenCalledTimes(1);
        expect(host.history.value.previous(``)).toBe(`Continue`);
        expect(host.pin).toHaveBeenCalledTimes(1);
    });
});

describe(`what the composer says`, () => {
    it(`names Stop by what it will do to the turn`, () => {
        const { chat, host, send } = composerOf();
        runningTurn(chat.turn);
        expect(send.stopLabel.value).toBe(`Stop generating`);
        expect(send.stopHint.value).toEqual({ title: `Stop`, keys: `Esc` });
        host.mobile.value = true;
        expect(send.stopHint.value).toBe(`Stop`);

        chat.transcript.adopt([{ id: 1, role: `assistant`, text: ``, permission: { requestId: `p1`, toolName: `Bash`, status: `pending` } }]);
        expect(send.stopLabel.value).toBe(`Stop the turn`);
        expect(send.stopHint.value).toEqual({ title: `Stop turn`, note: `Discards request above` });
    });

    it(`keeps Send in the slot mid-turn only while the box holds something`, () => {
        const { chat, send } = composerOf();
        expect(send.sendShown.value).toBe(true);

        runningTurn(chat.turn);
        expect(send.sendShown.value).toBe(false);

        chat.draft.value = `and the footer`;
        expect(send.sendShown.value).toBe(true);
    });

    it(`tells a viewer the box is not theirs to write in`, () => {
        const { host, send } = composerOf();

        host.canDrive.value = false;

        expect(send.composerPlaceholder.value).toBe(viewerPlaceholder());
    });
});
