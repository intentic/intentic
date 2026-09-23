import { type AgentEvent, type AgentReply, AgentReplySchema, type RequestField } from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { ref } from "vue";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import type { SandboxRpc } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// Pins the one way a parked turn is answered: every card kind through the same route, addressed by its request id,
// frozen only once the daemon took it, and what each kind of answer then does to the turn.

// The daemon's reply route, the only call an answer makes; a test holds it open or refuses it.
const { replyRoute } = { replyRoute: jest.fn<SandboxRpc["agent"]["reply"]>(async () => ({ ok: true as const })) };
jest.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agent: { reply: replyRoute } }) }));

const { CardReplies, afterReply, planFeedback, refusalOf, requestIdOf } = await import("./cardReplies");
const { TranscriptClock } = await import("../transcript/transcriptClock");
type CardAnswer = Parameters<InstanceType<typeof CardReplies>["reply"]>[1];

const PAYMENT = {
    url: `https://api.example.com/report`,
    payTo: `0xabc`,
    network: `eip155:8453`,
    asset: `0xusdc`,
    assetName: `USDC`,
    amountUsd: `0.10`,
    spentTodayUsd: `0.00`,
    dailyCapUsd: `5.00`,
};
const CREDENTIAL = {
    subject: `DATABASE_URL`,
    kind: `secret` as const,
    lane: `shell` as const,
    approvers: [`bob@corp.com`],
    scope: `use` as const,
};
const QUESTIONS = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];

// Every card kind as the daemon raises it, one answer each, and the status that answer freezes it at.
const CARDS: readonly { readonly event: AgentEvent; readonly field: RequestField; readonly answer: CardAnswer; readonly settled: string }[] = [
    { event: { kind: `plan`, requestId: `r1`, text: `the plan` }, field: `plan`, answer: { kind: `plan`, approve: true }, settled: `approved` },
    {
        event: { kind: `question`, requestId: `r1`, questions: QUESTIONS },
        field: `question`,
        answer: { kind: `question`, answers: { "Which?": [`A`] } },
        settled: `answered`,
    },
    {
        event: { kind: `permission`, requestId: `r1`, toolName: `Bash` },
        field: `permission`,
        answer: { kind: `permission`, decision: `always` },
        settled: `always`,
    },
    {
        event: { kind: `browser_help`, requestId: `r1`, session: `browser-s1`, account: `work`, message: `a captcha` },
        field: `browserHelp`,
        answer: { kind: `browser_help`, helped: false },
        settled: `declined`,
    },
    {
        event: { kind: `terminal_help`, requestId: `r1`, session: `agent-s1`, message: `a one-time code` },
        field: `terminalHelp`,
        answer: { kind: `terminal_help`, helped: false },
        settled: `declined`,
    },
    {
        event: { kind: `capability_offer`, requestId: `r1`, offer: { entry: `notion`, name: `Notion` } },
        field: `capabilityOffer`,
        answer: { kind: `capability_offer`, connect: false },
        settled: `skipped`,
    },
    {
        event: { kind: `payment_offer`, requestId: `r1`, offer: PAYMENT },
        field: `paymentOffer`,
        answer: { kind: `payment_offer`, approve: true },
        settled: `approved`,
    },
    {
        event: { kind: `credential_offer`, requestId: `r1`, offer: CREDENTIAL },
        field: `credentialOffer`,
        answer: { kind: `credential_offer`, approve: false },
        settled: `skipped`,
    },
];

// A chat parked on the given cards, in the order raised, beneath the prompt that started the turn.
const parkedOn = (...events: AgentEvent[]) => {
    const fold = new TranscriptFold([userRow(`go`, 1, [])]);
    for (const event of events) {
        fold.apply(event);
    }
    const transcript = new TranscriptClock(() => undefined);
    transcript.rebuild(fold.rows);
    const turn = { stop: jest.fn(), endedByReader: jest.fn() };
    const host = { box: ref<string | undefined>(`box-2`), transcript, error: ref<string | null>(null), turn, peek: ref(true) };
    const cardOf = (field: RequestField, requestId: string) => transcript.messages.value.find((row) => row[field]?.requestId === requestId)?.[field];
    return { host, turn, cardOf, replies: new CardReplies(host) };
};

afterEach(() => {
    replyRoute.mockReset();
    replyRoute.mockImplementation(async () => ({ ok: true as const }));
});

describe(`reply`, () => {
    it(`covers every kind of answer the contract carries`, () => {
        expect(CARDS.map((card) => card.answer.kind).toSorted()).toEqual(
            AgentReplySchema.options.map((option) => option.shape.kind.value).toSorted(),
        );
    });

    for (const { event, field, answer, settled } of CARDS) {
        it(`answers a ${answer.kind} card through the one route and freezes that card alone`, async () => {
            const chat = parkedOn({ kind: `permission`, requestId: `p0`, toolName: `Write` }, event);

            expect(await chat.replies.reply(`r1`, answer)).toBe(true);

            expect(replyRoute.mock.calls).toEqual([[{ ...answer, requestId: `r1` } as AgentReply, { context: { at: `box-2` } }]]);
            expect(chat.cardOf(field, `r1`)).toMatchObject({ requestId: `r1`, status: settled });
            // The card raised before it is still the reader's to answer.
            expect(chat.cardOf(`permission`, `p0`)).toMatchObject({ status: `pending` });
            expect(chat.host.peek.value).toBe(false);
            expect(chat.host.error.value).toBeNull();
            // The turn goes on: what waited behind the card is the daemon's to say into it, for every window at once.
            expect(chat.turn.stop).not.toHaveBeenCalled();
            expect(chat.turn.endedByReader).not.toHaveBeenCalled();
        });
    }

    it(`says a refusal on the red line in the card's own words, and leaves the card answerable`, async () => {
        const chat = parkedOn({ kind: `payment_offer`, requestId: `r1`, offer: PAYMENT });
        replyRoute.mockImplementationOnce(async () => {
            throw new SandboxHttpError(404, `Not found.`);
        });

        expect(await chat.replies.reply(`r1`, { kind: `payment_offer`, approve: true })).toBe(false);
        expect(chat.host.error.value).toBe(`Could not record your decision: the offer may have expired.`);
        expect(chat.cardOf(`paymentOffer`, `r1`)).toMatchObject({ status: `pending` });
        expect(chat.replies.isReplying(`r1`)).toBe(false);
        expect(chat.turn.stop).not.toHaveBeenCalled();

        // The same press again is a fresh answer, not a repeat of the refused one.
        expect(await chat.replies.reply(`r1`, { kind: `payment_offer`, approve: true })).toBe(true);
        expect(chat.cardOf(`paymentOffer`, `r1`)).toMatchObject({ status: `approved` });
    });

    it(`answers a card once: a second press while the first is on its way sends nothing`, async () => {
        const chat = parkedOn({ kind: `permission`, requestId: `r1`, toolName: `Bash` });
        let land = (): void => undefined;
        replyRoute.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    land = () => resolve({ ok: true });
                }),
        );

        const allow = chat.replies.reply(`r1`, { kind: `permission`, decision: `once` });
        const deny = chat.replies.reply(`r1`, { kind: `permission`, decision: `deny` });
        expect(chat.replies.isReplying(`r1`)).toBe(true);
        land();

        expect(await Promise.all([allow, deny])).toEqual([true, false]);
        expect(replyRoute).toHaveBeenCalledTimes(1);
        expect(chat.replies.isReplying(`r1`)).toBe(false);
        expect(chat.cardOf(`permission`, `r1`)).toMatchObject({ status: `allowed` });
    });

    it(`sends nothing for a request id with no pending card of that kind`, async () => {
        const chat = parkedOn({ kind: `permission`, requestId: `r1`, toolName: `Bash` });

        expect(await chat.replies.reply(`gone`, { kind: `permission`, decision: `once` })).toBe(false);
        // The id is right but the answer is another card's: nothing of that kind waits under it.
        expect(await chat.replies.reply(`r1`, { kind: `plan`, approve: true })).toBe(false);
        // Nothing was answered, so nothing was done to the chat: it is still only being looked at.
        expect(chat.host.peek.value).toBe(true);
        expect(await chat.replies.reply(`r1`, { kind: `permission`, decision: `once` })).toBe(true);
        // Answered already, so no longer pending.
        expect(await chat.replies.reply(`r1`, { kind: `permission`, decision: `deny` })).toBe(false);

        expect(replyRoute).toHaveBeenCalledTimes(1);
        expect(chat.host.peek.value).toBe(false);
    });

    it(`ends the turn on a dismissed question and stops it on a bare denial`, async () => {
        const asked = parkedOn({ kind: `question`, requestId: `r1`, questions: QUESTIONS });
        await asked.replies.reply(`r1`, { kind: `question`, cancelled: true });
        expect(asked.cardOf(`question`, `r1`)).toMatchObject({ status: `cancelled` });
        expect(asked.turn.endedByReader).toHaveBeenCalledTimes(1);
        expect(asked.turn.stop).not.toHaveBeenCalled();

        const denied = parkedOn({ kind: `permission`, requestId: `r1`, toolName: `Bash` });
        await denied.replies.reply(`r1`, { kind: `permission`, decision: `deny` });
        expect(denied.cardOf(`permission`, `r1`)).toMatchObject({ status: `denied` });
        expect(denied.turn.stop).toHaveBeenCalledTimes(1);
        expect(denied.turn.endedByReader).not.toHaveBeenCalled();
    });
});

describe(`afterReply`, () => {
    it(`ends, stops or lets the turn go on, by the answer alone`, () => {
        expect(afterReply({ kind: `question`, cancelled: true })).toBe(`end`);
        expect(afterReply({ kind: `question`, answers: { "Which?": [`A`] } })).toBe(`go on`);
        expect(afterReply({ kind: `permission`, decision: `deny` })).toBe(`stop`);
        // A denial with something to steer by carries the turn on instead.
        expect(afterReply({ kind: `permission`, decision: `deny`, feedback: `use the other file` })).toBe(`go on`);
        expect(afterReply({ kind: `permission`, decision: `once` })).toBe(`go on`);
        expect(afterReply({ kind: `plan`, approve: false })).toBe(`go on`);
    });
});

describe(`refusalOf`, () => {
    it(`words each card's refusal as that card always has`, () => {
        expect(refusalOf({ kind: `plan`, approve: true })).toBe(`Could not record your plan decision: the turn may have ended.`);
        expect(refusalOf({ kind: `question`, answers: {} })).toBe(`Could not submit your answers: the turn may have ended.`);
        expect(refusalOf({ kind: `question`, cancelled: true })).toBe(`Could not dismiss the question: the turn may have ended.`);
        expect(refusalOf({ kind: `permission`, decision: `once` })).toBe(`Could not record your decision: the turn may have ended.`);
        expect(refusalOf({ kind: `payment_offer`, approve: true })).toBe(`Could not record your decision: the offer may have expired.`);
        expect(refusalOf({ kind: `credential_offer`, approve: true })).toBe(
            `Could not record your decision: the card may have expired, or it may not be yours to answer.`,
        );
        expect(refusalOf({ kind: `capability_offer`, connect: true })).toBe(`Could not record your decision: the ask may have expired.`);
        expect(refusalOf({ kind: `browser_help`, helped: false })).toBe(`Could not send that: the turn may have ended.`);
        expect(refusalOf({ kind: `terminal_help`, helped: false })).toBe(`Could not send that: the turn may have ended.`);
    });
});

describe(`planFeedback`, () => {
    it(`joins the typed words and the staged files as @-paths, one per line`, () => {
        expect(
            planFeedback(`  not this way `, [
                { name: `shot.png`, path: `.intentic/a/shot.png` },
                { name: `notes.md`, path: `docs/notes.md` },
            ]),
        ).toBe(`not this way\n@.intentic/a/shot.png\n@docs/notes.md`);
        expect(planFeedback(``, [{ name: `shot.png`, path: `.intentic/a/shot.png` }])).toBe(`@.intentic/a/shot.png`);
    });

    it(`is nothing when there are neither words nor files`, () => {
        expect(planFeedback(`   `)).toBeUndefined();
        expect(planFeedback(undefined, [])).toBeUndefined();
    });
});

describe(`requestIdOf`, () => {
    it(`reads the one card a row holds, whichever kind it is`, () => {
        for (const { event, field } of CARDS) {
            const [prompt, card] = parkedOn(event).host.transcript.messages.value;
            expect(card === undefined ? `no row` : requestIdOf(card), field).toBe(`r1`);
            // The prompt above it holds none.
            expect(prompt === undefined ? `no row` : requestIdOf(prompt), field).toBeUndefined();
        }
    });
});
