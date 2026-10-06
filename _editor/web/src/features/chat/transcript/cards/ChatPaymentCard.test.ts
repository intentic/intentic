// Needs jsdom: a payment's Pay button was drawn for every reader, while the sandbox takes a payment's answer from the
// owner alone (wallet/payment-offer.ts), so anyone else pressed a button that could only be refused.
import "@intentic/testing/dom";
import type { MemberRole } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { type App, computed, createApp, h, ref } from "vue";
import type { CardAnswer } from "../../session/cardReplies";
import type { ChatMessage } from "../transcript";
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

let app: App | undefined;
const sent: CardAnswer[] = [];
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatPaymentCard, {
                message: CARD,
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
