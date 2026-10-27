// Needs jsdom: a resolved ask folds to the one fact its chip does not say, the name setup saved the connection under, with
// the agent's case one press away; the clause saying the agent carried on is what any answer means, so it is not drawn.
import "@intentic/testing/dom";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { CapabilityOutcome } from "@intentic/sandbox-contract/events/requests";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import ChatCapabilityCard from "./ChatCapabilityCard.vue";

// The card's row once the owner said yes and setup ended as `outcome` says, as the daemon's own fold leaves it.
const settledAs = (outcome: CapabilityOutcome): ChatMessage => {
    const fold = new TranscriptFold([userRow(`go`, 1, [])]);
    const frames: AgentEvent[] = [
        { kind: `capability_offer`, requestId: `c1`, offer: { entry: `github`, name: `GitHub`, why: `To open an issue for each bug.` } },
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
const mount = (message: ChatMessage): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatCapabilityCard, { message, settling: false, reply: async () => {} }) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // Read only by the Connect press, which nothing here makes.
    app.use(createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: defineComponent({ render: () => null }) }] }));
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`names the connection setup saved, and nothing the chip already says`, () => {
    const element = mount(settledAs({ outcome: `connected`, id: `github-work` }));
    const saved = element.querySelector(`[data-capability-saved-as]`);
    expect(saved?.firstChild?.textContent?.trim()).toBe(`Saved as`);
    expect(saved?.querySelector(`.font-mono`)?.textContent).toBe(`github-work`);
    expect(element.textContent).not.toContain(`continuing`);
});

it(`folds the agent's case behind a press`, async () => {
    const element = mount(settledAs({ outcome: `connected`, id: `github-work` }));
    expect(element.querySelector(`[data-agent-case]`)).toBeNull();
    element.querySelector<HTMLButtonElement>(`[data-card-outcome-toggle]`)?.click();
    await nextTick();
    expect(element.querySelector(`[data-agent-case]`)?.textContent).toContain(`To open an issue for each bug.`);
});

it(`says no name when setup named no account`, () => {
    const element = mount(settledAs({ outcome: `connected` }));
    expect(element.querySelector(`[data-capability-saved-as]`)).toBeNull();
});
