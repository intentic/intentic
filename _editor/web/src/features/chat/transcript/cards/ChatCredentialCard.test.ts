// Needs jsdom: an answered release folds to who answered it when that was somebody other than the reader, with the ask
// one press away. The chip says which way it went, and the agent carrying on is what any answer means.
import "@intentic/testing/dom";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { CredentialReceipt } from "@intentic/sandbox-contract/events/requests";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";

// The viewer, one of the card's approvers; the card reads nothing else of the session.
jest.mock("../../../../client/session/sandboxSession", () => ({ useSandboxSession: () => ({ presentedEmail: ref(`bob@corp.com`) }) }));

const { default: ChatCredentialCard } = await import("./ChatCredentialCard.vue");

const CREDENTIAL = { subject: `DATABASE_URL`, kind: `secret`, lane: `shell`, approvers: [`bob@corp.com`, `grace@acme.dev`], scope: `use` } as const;

// The card's row once an approver answered and the daemon reported it as `receipt` says, as the daemon's own fold leaves it.
const answeredWith = (receipt: CredentialReceipt): ChatMessage => {
    const fold = new TranscriptFold([userRow(`go`, 1, [])]);
    const frames: AgentEvent[] = [
        { kind: `credential_offer`, requestId: `k1`, offer: { ...CREDENTIAL, approvers: [...CREDENTIAL.approvers] } },
        { kind: `resolved`, requestId: `k1`, reply: { kind: `credential_offer`, requestId: `k1`, approve: receipt.outcome === `released` } },
        { kind: `credential_receipt`, requestId: `k1`, ...receipt },
    ];
    for (const frame of frames) {
        fold.apply(frame);
    }
    const row = fold.rows.find((candidate) => candidate.credentialOffer !== undefined);
    if (row === undefined) {
        throw new Error(`the fold drew no credential card`);
    }
    return { ...row, id: 2 };
};

// Each label and value the facts list holds, in reading order.
const factWords = (element: HTMLElement): string[] => [...element.querySelectorAll(`[data-card-facts] > *`)].map((part) => part.textContent?.trim() ?? ``);

let app: App | undefined;
const mount = (message: ChatMessage): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatCredentialCard, { message, settling: false, reply: async () => {} }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`names a teammate who answered, by face and address`, () => {
    const element = mount(answeredWith({ outcome: `refused`, approvedBy: `grace@acme.dev` }));
    expect(element.querySelector(`[data-card-person]`)?.textContent).toContain(`grace@acme.dev`);
    expect(element.textContent).not.toContain(`carry on`);
});

it(`names nobody when the reader answered it`, () => {
    const element = mount(answeredWith({ outcome: `released`, approvedBy: `bob@corp.com` }));
    expect(element.querySelector(`[data-card-person]`)).toBeNull();
});

it(`keeps the ask, with who may answer and what one yes covers, one press away`, async () => {
    const element = mount(answeredWith({ outcome: `released`, approvedBy: `bob@corp.com` }));
    expect(element.querySelector(`[data-card-facts]`)).toBeNull();
    element.querySelector<HTMLButtonElement>(`[data-card-outcome-toggle]`)?.click();
    await nextTick();
    expect(factWords(element)).toEqual([`Approvers`, `bob@corp.com, grace@acme.dev`, `Covers`, `This one use: the next one asks again`]);
});
