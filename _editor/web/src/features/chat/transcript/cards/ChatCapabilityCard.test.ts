// Needs jsdom: the line under a resolved ask is one sentence joined from three messages, and only a render shows whether a
// space survives the joins, in every language the editor ships.
import "@intentic/testing/dom";
import type { AgentEvent, CapabilityOutcome } from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { type Locale, setLocale } from "@intentic/ui/i18n";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, defineComponent, h } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import type { ChatMessage } from "../transcript";
import ChatCapabilityCard from "./ChatCapabilityCard.vue";

// The card's row once the owner said yes and setup ended as `outcome` says, as the daemon's own fold leaves it.
const settledAs = (outcome: CapabilityOutcome): ChatMessage => {
    const fold = new TranscriptFold([userRow(`go`, 1, [])]);
    const frames: AgentEvent[] = [
        { kind: `capability_offer`, requestId: `c1`, offer: { entry: `github`, name: `GitHub` } },
        { kind: `resolved`, requestId: `c1`, reply: { kind: `capability_offer`, requestId: `c1`, connect: true } },
        { kind: `capability_outcome`, requestId: `c1`, ...outcome },
    ];
    for (const frame of frames) {
        fold.apply(frame);
    }
    const row = fold.rows.find((candidate) => candidate.capabilityOffer !== undefined);
    if (row === undefined) {
        throw new Error(`the fold drew no capability card`);
    }
    return { ...row, id: 2 };
};

let app: App | undefined;
// What the card says under the resolved ask, the only text this suite is about.
const outcomeLine = (message: ChatMessage): string | null | undefined => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatCapabilityCard, { message, settling: false, reply: async () => {} }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // Read only by the Connect press, which nothing here makes.
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: defineComponent({ render: () => null }) }] }));
    app.mount(element);
    return element.querySelector(`.chat-card-row > span`)?.textContent;
};

afterEach(async () => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    await setLocale(`en`);
});

it(`says who it connected as, with a space between the words and none before the clause`, () => {
    expect(outcomeLine(settledAs({ outcome: `connected`, id: `github` }))).toBe(`Connected as "github": the agent is continuing with it.`);
});

it(`goes straight to the clause when setup named no account`, () => {
    expect(outcomeLine(settledAs({ outcome: `connected` }))).toBe(`Connected: the agent is continuing with it.`);
});

// Each language's clause brings its own lead-in (French spaces its colon), so the join adds one space and nothing else.
const IN_EACH_LANGUAGE: readonly (readonly [Locale, string])[] = [
    [`de`, `Verbunden als „github“: der Agent macht damit weiter.`],
    [`es`, `Conectado como «github»: el agente sigue con ello.`],
    [`fr`, `Connecté sous « github » : l'agent continue avec.`],
    [`pl`, `Podłączone jako „github”: agent idzie z tym dalej.`],
];
for (const [locale, line] of IN_EACH_LANGUAGE) {
    it(`reads as one sentence in ${locale}`, async () => {
        await setLocale(locale);
        expect(outcomeLine(settledAs({ outcome: `connected`, id: `github` }))).toBe(line);
    });
}
