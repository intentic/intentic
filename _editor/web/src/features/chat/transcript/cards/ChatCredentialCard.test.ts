// Needs jsdom: the line under a refused release is one sentence joined from three messages, and only a render shows
// whether a space survives the joins, in every language the editor ships.
import "@intentic/testing/dom";
import type { AgentEvent, CredentialReceipt } from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { type Locale, setLocale } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, ref } from "vue";
import type { ChatMessage } from "../transcript";

// The viewer, one of the card's approvers; the card reads nothing else of the session.
jest.mock("../../../../client/session/sandboxSession", () => ({ useSandboxSession: () => ({ presentedEmail: ref(`bob@corp.com`) }) }));

const { default: ChatCredentialCard } = await import("./ChatCredentialCard.vue");

const CREDENTIAL = { subject: `DATABASE_URL`, kind: `secret`, lane: `shell`, approvers: [`bob@corp.com`], scope: `use` } as const;

// The card's row once an approver said no and the daemon reported it as `receipt` says, as the daemon's own fold leaves it.
const refusedWith = (receipt: CredentialReceipt): ChatMessage => {
    const fold = new TranscriptFold([userRow(`go`, 1, [])]);
    const frames: AgentEvent[] = [
        { kind: `credential_offer`, requestId: `k1`, offer: { ...CREDENTIAL, approvers: [...CREDENTIAL.approvers] } },
        { kind: `resolved`, requestId: `k1`, reply: { kind: `credential_offer`, requestId: `k1`, approve: false } },
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

let app: App | undefined;
// What the card says under the answered release, the only text this suite is about.
const receiptLine = (message: ChatMessage): string | null | undefined => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatCredentialCard, { message, settling: false, reply: async () => {} }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element.querySelector(`.chat-card-row > span`)?.textContent;
};

afterEach(async () => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    await setLocale(`en`);
});

it(`names who refused, with a space between the words and none before the clause`, () => {
    expect(receiptLine(refusedWith({ outcome: `refused`, approvedBy: `bob@corp.com` }))).toBe(
        `Refused by bob@corp.com: the agent was told to carry on without it.`,
    );
});

it(`goes straight to the clause when no one was verified as refusing`, () => {
    expect(receiptLine(refusedWith({ outcome: `refused` }))).toBe(`Refused: the agent was told to carry on without it.`);
});

// Each language's clause brings its own lead-in (French spaces its colon), so the join adds one space and nothing else.
const IN_EACH_LANGUAGE: readonly (readonly [Locale, string])[] = [
    [`de`, `Abgelehnt von bob@corp.com: dem Agenten wurde gesagt, er solle ohne es weitermachen.`],
    [`es`, `Rechazado por bob@corp.com: al agente se le dijo que continuara sin ello.`],
    [`fr`, `Refusé par bob@corp.com : il a été dit à l'agent de continuer sans.`],
    [`pl`, `Odrzucone przez bob@corp.com: agentowi kazano iść dalej bez tego.`],
];
for (const [locale, line] of IN_EACH_LANGUAGE) {
    it(`reads as one sentence in ${locale}`, async () => {
        await setLocale(locale);
        expect(receiptLine(refusedWith({ outcome: `refused`, approvedBy: `bob@corp.com` }))).toBe(line);
    });
}
