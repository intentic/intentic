// @vitest-environment jsdom
// Tests that the picker discloses what a runtime can't do (from the record, limitationsOf) without spending
// permanent space: one row with a count, full text on hover. Not about which words the record chose.
import { type AgentHarness, type AgentProvider, capabilitiesOf, limitationsOf } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import type { Conversation } from "../session/conversation";
import { IconStub } from "@intentic/ui/testing";

// ModelPicker is tested on its own; stubbed to its footer slot so only the footer mounts here.
vi.mock(`./ModelPicker.vue`, () => ({
    default: defineComponent({
        setup:
            (_props, { slots }) =>
            () =>
                h(`div`, slots[`footer`]?.()),
    }),
}));
// Account catalogs live in the shared block; stubbed empty so the footer shows only the runtime's own rows.
vi.mock(`../accounts/PickerAccounts.vue`, () => ({ default: defineComponent({ setup: () => () => h(`div`) }) }));
vi.mock(`../accounts/pickerAccounts`, () => ({ usePickerAccounts: () => ({ hasContent: computed(() => false) }) }));
// The sandbox-wide tier mode, off here so the footer holds exactly the rows under test.
vi.mock(`../../sandbox/overview/useSandboxSettings`, () => ({ useSandboxSettings: () => ({ settings: ref({ autoTier: `off` }) }) }));

const { default: ChatModelPicker } = await import("./ChatModelPicker.vue");

// Grok native, the weakest runtime (something to disclose); Claude Code, the ceiling; both from the contract.
const ROUTED = { provider: `grok`, harness: `native` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const CEILING = { provider: `claude`, harness: `claude-code` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const limitsOf = (pair: { provider: AgentProvider; harness: AgentHarness }): string[] => limitationsOf(capabilitiesOf(pair.provider, pair.harness));

// The conversation as this panel reads it: just the refs it binds and the writes it makes, no transcript machinery.
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
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// The hint's trigger: the parent of the focusable span the icon sits in.
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
    // The card teleports out of the panel (escapes overlay clipping), so read it off the document.
    for (const limit of limits) {
        expect(document.body.textContent).toContain(limit);
    }

    hint(element).dispatchEvent(new MouseEvent(`mouseleave`));
    await nextTick();
    expect(document.body.textContent).not.toContain(limits[0]);
});

// The ceiling has nothing to disclose; a row reading 0 would invent a caveat the record doesn't have. The
// footer still draws (extended thinking), so this tests the row, not an empty footer.
it(`says nothing at all when the runtime is the ceiling`, () => {
    expect(limitsOf(CEILING)).toEqual([]);

    const element = mount(CEILING);

    expect(element.textContent).toContain(`Extended thinking`);
    expect(element.textContent).not.toContain(`Not available here`);
    expect(element.querySelector(`[tabindex="0"]`)).toBeNull();
});
