// Needs jsdom: a payment's Pay button was drawn for every reader, while the sandbox takes a payment's answer from the
// owner alone (wallet/payment-offer.ts), so anyone else pressed a button that could only be refused.
import "@intentic/testing/dom";
import type { MemberRole } from "@intentic/sandbox-contract/schemas/shared";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, h, nextTick, ref } from "vue";
import type { CardAnswer } from "../../../../models/conversations/session/cardReplies";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatPaymentCard from "./ChatPaymentCard.vue";

const role = ref<MemberRole>(`owner`);
jest.mock(`../../../../client/sandbox/useRole`, () => ({ useRole: () => ({ isOwner: computed(() => role.value === `owner`) }) }));

const CARD: ChatMessage = {
    id: 3,
    role: `assistant`,
    text: ``,
    paymentOffer: {
        requestId: `pay-1`,
        status: `pending`,
        offer: {
            url: `https://api.example.com/report`,
            payTo: `0xabc`,
            network: `eip155:8453`,
            asset: `0xusdc`,
            assetName: `USDC`,
            amountUsd: `0.10`,
            spentTodayUsd: `0.00`,
            dailyCapUsd: `5.00`,
        },
    },
};

// Each label and value the facts list holds, in reading order.
const factWords = (element: HTMLElement): string[] => [...element.querySelectorAll(`[data-card-facts] > *`)].map((part) => part.textContent?.trim() ?? ``);

let app: App | undefined;
const sent: CardAnswer[] = [];
const mount = (message: ChatMessage = CARD): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatPaymentCard, {
                message,
                settling: false,
                reply: async (answer: CardAnswer) => {
                    sent.push(answer);
                },
            }),
    });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    sent.length = 0;
    role.value = `owner`;
});

const buttons = (element: HTMLElement): string[] => [...element.querySelectorAll(`button`)].map((button) => button.textContent?.trim() ?? ``);

it(`offers the owner Pay and Skip`, () => {
    const element = mount();
    expect(buttons(element)).toEqual([`Pay $0.10`, `Skip: free`]);
});

it(`offers a maintainer no answer, and says whose it is`, () => {
    role.value = `maintainer`;
    const element = mount();
    expect(buttons(element)).toEqual([]);
    expect(element.textContent).toContain(`Only this sandbox's owner can approve a payment: the wallet that pays is theirs.`);
});

// Paid, the card is history: the receipt on one line, and where the money went one press away.
it(`folds a paid payment to its receipt`, async () => {
    const offer = CARD.paymentOffer!;
    const element = mount({
        ...CARD,
        paymentOffer: { ...offer, status: `approved`, receipt: { outcome: `paid`, amountUsd: `0.10`, transaction: `0x4be1`, network: `base` } },
    });
    expect(buttons(element)).toEqual([`Details`]);
    expect(element.textContent).toContain(`Paid $0.10`);
    expect(element.querySelector(`[data-card-facts]`)).toBeNull();
    element.querySelector<HTMLButtonElement>(`[data-card-outcome-toggle]`)?.click();
    await nextTick();
    expect(factWords(element)).toEqual([`Endpoint`, `https://api.example.com/report`, `Pays to`, `0xabc`, `Spent today`, `$0.00 of $5.00`]);
});
