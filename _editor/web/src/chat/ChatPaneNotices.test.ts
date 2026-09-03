// @vitest-environment jsdom
//
/* THE TRIAL'S STANDING, SAID ABOVE THE COMPOSER, and the difference between the two states that reach for the
 * reader.
 *
 * The platform's key pool publishes one word about itself. `unavailable` is an interruption: nothing answered,
 * the turn is held below, and the strip owes the user the press that sends it again. `degraded` is not: the
 * pool answered after failing over to another key or another rung, which is what a ladder is for. Both used to
 * get the same sentence ("Failed messages are not counted") and the same Retry button, so a person reading a
 * perfectly good answer was told above it that their message had failed. That is what these tests hold shut.
 *
 * The row itself is pinned too, because it went wrong in a way a screenshot shows and a snapshot does not: a
 * kit button beside a hand-styled link, two font sizes and three baselines in a row three items long. One box
 * holds the actions now, and the sentence has a width floor so the row wraps instead of being squeezed into a
 * column of single words. */
import { type AgentProvider, TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

const provider = ref<AgentProvider>(TRIAL_PROVIDER);
const reachable = ref(true);
const streaming = ref(false);
const resume = vi.fn(async () => {});
const loadTrialStatus = vi.fn(async () => {});

// The pane's own view, which the real strip injects from its ChatPane: mounted bare here, so it is handed over.
vi.mock(`../composables/chat/useChat`, () => ({
    loadTrialStatus,
    usePaneView: () => ({
        conversation: ref({ conversationId: `agent-1`, resume }),
        provider,
        account: ref(undefined),
        accounts: ref([]),
        streaming,
        harness: ref(`claude-code`),
        model: ref(`gemini-flash-latest`),
        selectModel: () => {},
        selectHarness: () => {},
        selectAccount: () => {},
    }),
}));
vi.mock(`../composables/sandbox/useSandbox`, () => ({ useSandbox: () => ({ reachable }) }));
vi.mock(`../composables/agents/useAgents`, () => ({
    useAgents: () => ({
        agentById: () => undefined,
        archived: ref([]),
        loadArchived: vi.fn(async () => {}),
        restore: vi.fn(),
        busyIds: ref([]),
    }),
}));
// The account gate is its own component with its own test and its own half-dozen reads; this file is about the
// trial strip that sits under it.
vi.mock(`./ChatAccountPanel.vue`, () => ({ default: defineComponent({ name: `ChatAccountPanel`, setup: () => () => undefined }) }));
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    RouterLink: (await import(`../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { trialStatus } = await import("../composables/chat/providerCatalog");
const { default: ChatPaneNotices } = await import("./ChatPaneNotices.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatPaneNotices) });
    app.component(
        `Icon`,
        defineComponent({
            props: { name: { type: String, default: `` }, spin: Boolean },
            setup: (props) => () => h(`i`, { "data-icon": props.name }),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const named = (element: HTMLElement, label: string): HTMLElement | undefined =>
    [...element.querySelectorAll(`button, a`)].find((control): control is HTMLElement => control.textContent?.includes(label) === true);

beforeEach(() => {
    provider.value = TRIAL_PROVIDER;
    reachable.value = true;
    streaming.value = false;
    trialStatus.value = { available: true, allowance: 10, used: 2, remaining: 8, health: `healthy` };
    resume.mockClear();
    loadTrialStatus.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* THE BUG PEOPLE REPORTED: "Free trial degraded. Failed messages are not counted.", in a chat whose model had
 * just answered. A pool that failed over is a pool that worked, so the line stays the ordinary one, and the
 * state rides along at the end of it rather than replacing it. */
it(`reports a pool that answered as a working trial, whatever it went through to answer`, () => {
    trialStatus.value = { ...trialStatus.value, health: `degraded`, servedModel: `gemini-flash-lite-latest` };

    const element = mount();

    expect(element.textContent).toContain(`8 free messages left today`);
    expect(element.textContent).toContain(`Last answer: gemini-flash-lite-latest`);
    expect(element.textContent).toContain(`Trial capacity is tight right now`);
    // The two claims that were false over an answered turn: that a message failed, and that there is something
    // to press about it.
    expect(element.textContent).not.toContain(`Failed messages are not counted`);
    expect(element.textContent).not.toContain(`degraded`);
    expect(named(element, `Retry`)).toBeUndefined();
});

// Healthy says nothing about the pool at all: there is nothing to say, and the count is what the reader wants.
it(`says nothing about the pool while it is answering cleanly`, () => {
    const element = mount();

    expect(element.textContent).toContain(`8 free messages left today`);
    expect(element.textContent).not.toContain(`Trial capacity is tight`);
    expect(named(element, `Retry`)).toBeUndefined();
});

/* The state that IS an interruption. The turn is held below (turnFailures holds it and the platform refunds
 * it), so the strip names the failure and carries the press that sends it again. */
it(`interrupts, with the press that sends the held turn, only when nothing answered`, async () => {
    trialStatus.value = { ...trialStatus.value, health: `unavailable` };

    const element = mount();

    expect(element.textContent).toContain(`Free trial isn't answering right now`);
    expect(element.textContent).toContain(`Failed messages are not counted`);

    named(element, `Retry`)?.click();
    await nextTick();

    expect(loadTrialStatus).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
});

// Spent is the signpost, not a warning: the free Google sign-in and the model list, both one press away.
it(`turns into the way out once today's allowance is gone`, () => {
    trialStatus.value = { ...trialStatus.value, used: 10, remaining: 0 };

    const element = mount();

    expect(element.textContent).toContain(`Free trial used up for today`);
    expect(named(element, `Choose a model`)).toEqual(expect.any(Object));
    expect(named(element, `Connect Google`)).toEqual(expect.any(Object));
});

/* WHY THE ROW LOOKED BROKEN, in the two structural facts that made it so. The actions were siblings of the
 * sentence, each hung from wherever its own box began; and the sentence could shrink to nothing, so `flex-wrap`
 * never engaged and flexbox took the overflow out of the text instead of dropping the buttons to their own
 * row. */
it(`hangs every action off one box, and gives the sentence a floor to wrap against`, () => {
    trialStatus.value = { ...trialStatus.value, health: `unavailable` };

    const element = mount();
    const retry = named(element, `Retry`);
    const connect = named(element, `Connect Google`);

    expect(retry?.parentElement).toBe(connect?.parentElement);
    expect(retry?.parentElement?.className).toContain(`items-center`);
    // Both are the kit's button at the same size, which is where their shared baseline comes from, and the
    // sign-in is still a real link: it has an address, and Ctrl/⌘-click has to be able to use it.
    expect(retry?.className.split(` `)).toEqual(expect.arrayContaining([`p-button`]));
    expect(connect?.className.split(` `)).toEqual(expect.arrayContaining([`p-button`]));
    expect(connect?.tagName).toBe(`A`);
    const sentence = [...element.querySelectorAll(`span`)].find((span) => span.textContent?.includes(`Free trial isn't answering`) === true);
    expect(sentence?.className).toContain(`min-w-[14rem]`);
    expect(sentence?.className).not.toContain(`min-w-0`);
});
