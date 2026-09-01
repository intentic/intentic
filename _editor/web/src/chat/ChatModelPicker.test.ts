// @vitest-environment jsdom
//
/* WHAT THIS RUNTIME CANNOT DO, and the two things that have to be true of it at once.
 *
 * It has to be SAID: picking a routed runtime gives up per-tool approvals, mid-turn steering, plugins and the
 * rest, and the picker is the only place in the app that says so. Nothing else warns: the controls simply stop
 * working once the turn is running.
 *
 * And it has to COST ALMOST NOTHING TO SAY: the same list drawn as a wall of chips is a dozen of them under the
 * footer's four controls, which pushed the model list this panel exists for into a third of its own height. So
 * the row is one line with a count, and the sentences live on the hover card behind it.
 *
 * Both halves are load-bearing and they pull against each other, which is why they are pinned together here: a
 * later "let's just show them" restores the wall, and a later trim of the card drops the disclosure entirely.
 *
 * The limitations are read from the CONTRACT (limitationsOf), never re-typed here: this is a test about whether
 * the panel discloses the record, not about which words the record chose. */
import { type AgentHarness, type AgentProvider, capabilitiesOf, limitationsOf } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import type { Conversation } from "../composables/chat/conversation";

// The model list is ModelPicker's own component and its own test (ModelPicker.test.ts): stubbed to its footer
// slot, so what mounts here is the footer and nothing else.
vi.mock(`./ModelPicker.vue`, () => ({
    default: defineComponent({
        setup:
            (_props, { slots }) =>
            () =>
                h(`div`, slots[`footer`]?.()),
    }),
}));
// Who serves the next turn is the shared block's business, and it reads the account catalogs to answer. Both
// halves are stubbed silent: an empty accounts block is what leaves the footer to the runtime's own rows.
vi.mock(`./PickerAccounts.vue`, () => ({ default: defineComponent({ setup: () => () => h(`div`) }) }));
vi.mock(`../composables/chat/pickerAccounts`, () => ({ usePickerAccounts: () => ({ hasContent: computed(() => false) }) }));
// The sandbox-wide tier mode, off here so the footer holds exactly the rows under test.
vi.mock(`../composables/sandbox/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings: ref({ autoTier: `off` }) }) }));

const { default: ChatModelPicker } = await import("./ChatModelPicker.vue");

/* Grok on its own loop, the weakest runtime the picker offers and therefore the one with something to disclose,
 * against the Claude Code loop, which is the ceiling the list measures against. Both come from the contract, so
 * these stay true when the record changes. */
const ROUTED = { provider: `grok`, harness: `native` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const CEILING = { provider: `claude`, harness: `claude-code` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const limitsOf = (pair: { provider: AgentProvider; harness: AgentHarness }): string[] => limitationsOf(capabilitiesOf(pair.provider, pair.harness));

// The conversation as this panel reads it: the refs it binds and the writes it makes, and none of the transcript
// machinery behind them. A real Conversation would drag a daemon connection into a test about a footer row.
const conversation = (pair: { provider: AgentProvider; harness: AgentHarness }): Conversation =>
    ({
        provider: ref(pair.provider),
        harness: ref(pair.harness),
        model: ref(`a-model`),
        thinking: ref(false),
        fast: ref(false),
        fastOffered: computed(() => false),
        fastMode: ref(undefined),
        tierHold: ref(false),
        tierAnswer: ref(undefined),
        streaming: ref(false),
        generating: computed(() => false),
        account: ref(undefined),
        capabilities: computed(() => capabilitiesOf(pair.provider, pair.harness)),
        selectModel: vi.fn(),
        selectAccount: vi.fn(),
        selectHarness: vi.fn(),
        setThinking: vi.fn(),
        setFast: vi.fn(),
        setTierHold: vi.fn(),
    }) as unknown as Conversation;

let app: App | undefined;
const mount = (pair: { provider: AgentProvider; harness: AgentHarness } = ROUTED): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatModelPicker, { conversation: conversation(pair) }) });
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

// The hint's trigger: the element the hover is on, which is the parent of the focusable span the icon sits in.
const hint = (element: HTMLElement): HTMLElement => element.querySelector<HTMLElement>(`[tabindex="0"]`)!.parentElement!;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`spends one line on the runtime's limits, with the count where the list used to be`, () => {
    const element = mount();
    const limits = limitsOf(ROUTED);

    expect(limits.length).toBeGreaterThan(1); // the row is pointless on a runtime with nothing to say
    expect(element.textContent).toContain(`Not available here`);
    expect(element.textContent).toContain(`${limits.length}`);
    // The wall this replaced: not a sentence of it is in the panel until asked for.
    for (const limit of limits) {
        expect(element.textContent).not.toContain(limit);
    }
});

it(`hands over every limitation the contract declares, on hover, and takes it back after`, async () => {
    const element = mount();
    const limits = limitsOf(ROUTED);

    hint(element).dispatchEvent(new MouseEvent(`mouseenter`));
    await nextTick();
    // The card is teleported out of the panel (it has to escape the overlay's clipping), so it is read off the
    // document rather than the mount.
    for (const limit of limits) {
        expect(document.body.textContent).toContain(limit);
    }

    hint(element).dispatchEvent(new MouseEvent(`mouseleave`));
    await nextTick();
    expect(document.body.textContent).not.toContain(limits[0]);
});

// The ceiling has nothing to disclose, and a row reading "0" would be the picker inventing a caveat where the
// record has none. The footer is still drawn (extended thinking is a Claude knob), which is what makes this an
// assertion about the row rather than about the footer being empty.
it(`says nothing at all when the runtime is the ceiling`, () => {
    expect(limitsOf(CEILING)).toEqual([]);

    const element = mount(CEILING);

    expect(element.textContent).toContain(`Extended thinking`);
    expect(element.textContent).not.toContain(`Not available here`);
    expect(element.querySelector(`[tabindex="0"]`)).toBeNull();
});
