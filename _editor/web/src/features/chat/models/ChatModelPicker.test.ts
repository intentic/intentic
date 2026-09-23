// Tests that the picker discloses what a runtime can't do (from the record, limitationsOf) without spending
// permanent space: one row with a count, full text on hover. Not about which words the record chose. And that
// the run settings under it ARE the shared control (PickerRunSettings), drawn without the meter this surface
// already keeps beside its model pill.
import "@intentic/testing/dom";
import { type AgentHarness, type AgentProvider, capabilitiesOf, limitationsOf } from "@intentic/sandbox-contract";
import { type App, computed, createApp, defineComponent, h, nextTick, ref } from "vue";
import type { Conversation } from "../session/conversation";
import { IconStub } from "@intentic/ui/testing";

// ModelPicker is tested on its own; stubbed to its footer slot so only the footer mounts here. Its props are kept
// because the lead row (Auto) is a prop, not footer markup, and this binding is what decides whether it exists.
const pickerProps = ref<Record<string, unknown>>({});
jest.mock(`./ModelPicker.vue`, () => ({
    default: defineComponent({
        inheritAttrs: false,
        setup: (_props, { slots, attrs }) => {
            pickerProps.value = attrs;
            return () => h(`div`, slots[`footer`]?.());
        },
    }),
}));
// Account catalogs live in the shared block; stubbed empty so the footer shows only the runtime's own rows.
jest.mock(`../accounts/PickerAccounts.vue`, () => ({ default: defineComponent({ setup: () => () => h(`div`) }) }));
jest.mock(`../accounts/pickerAccounts`, () => ({ usePickerAccounts: () => ({ hasContent: computed(() => false) }) }));
const { default: ChatModelPicker } = await import("./ChatModelPicker.vue");
const { providerModels } = await import("../accounts/providerCatalog");
const { effortsFor } = await import("./run-settings/effortScale");

// Grok native, the weakest runtime (something to disclose); Claude Code, the ceiling; both from the contract.
const ROUTED = { provider: `grok`, harness: `native` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const CEILING = { provider: `claude`, harness: `claude-code` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
// The same ceiling under a provider with no Claude knobs: nothing to disclose, no thinking, no fast speed.
const BARE = { provider: `codex`, harness: `claude-code` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const limitsOf = (pair: { provider: AgentProvider; harness: AgentHarness }): string[] => limitationsOf(capabilitiesOf(pair.provider, pair.harness));

// The model every mount stands on, so a badge can be published against it.
const MODEL = `a-model`;

// The conversation as this panel reads it: just the refs it binds and the writes it makes, no transcript machinery.
const conversationOf = (pair: { provider: AgentProvider; harness: AgentHarness }, auto = false, sent = 0): Conversation =>
    ({
        selection: {
            provider: ref(pair.provider),
            harness: ref(pair.harness),
            model: ref(MODEL),
            thinking: ref(false),
            fast: ref(false),
            effort: computed(() => ``),
            auto: ref(auto),
            account: ref(undefined),
            capabilities: computed(() => capabilitiesOf(pair.provider, pair.harness)),
            apply: jest.fn(),
        },
        fastMode: ref(undefined),
        box: ref(undefined),
        transcript: { messages: ref(Array.from({ length: sent }, () => ({}))) },
        turn: { streaming: ref(false), generating: computed(() => false) },
    }) as unknown as Conversation;

let app: App | undefined;
// The conversation goes back with the element: the run-settings rows are asserted by the writes they make on it.
const mount = (
    pair: { provider: AgentProvider; harness: AgentHarness } = ROUTED,
    { auto = false, sent = 0 }: { auto?: boolean; sent?: number } = {},
): { element: HTMLElement; conversation: Conversation } => {
    const element = document.createElement(`div`);
    document.body.append(element);
    const held = conversationOf(pair, auto, sent);
    app = createApp({ render: () => h(ChatModelPicker, { conversation: held }) });
    app.component(`Icon`, IconStub);
    // The Auto footer links to the settings job; no router is mounted here, so the link renders as its words.
    app.component(
        `RouterLink`,
        defineComponent({
            setup:
                (_props, { slots }) =>
                () =>
                    h(`a`, slots[`default`]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(element);
    return { element, conversation: held };
};

// The hint's trigger: the parent of the focusable span the icon sits in.
const hint = (element: HTMLElement): HTMLElement => element.querySelector<HTMLElement>(`[tabindex="0"]`)!.parentElement!;

// The run-settings chips, by the shape a chip has: a pressed-state button carrying its own name. Read as
// `label → lit`, so a test says both which chips exist and which of them are on.
const chips = (element: HTMLElement): Record<string, boolean> =>
    Object.fromEntries(
        [...element.querySelectorAll(`button[aria-pressed]`)].map((chip) => [chip.textContent ?? ``, chip.getAttribute(`aria-pressed`) === `true`]),
    );
const chip = (element: HTMLElement, label: string): HTMLElement =>
    [...element.querySelectorAll<HTMLElement>(`button[aria-pressed]`)].find((candidate) => candidate.textContent === label)!;

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    providerModels.value = { ...providerModels.value, claude: [] };
});

it(`spends one line on the runtime's limits, with the count where the list used to be`, () => {
    const { element } = mount();
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
    const { element } = mount();
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

    const { element } = mount(CEILING);

    expect(element.textContent).toContain(`Extended thinking`);
    expect(element.textContent).not.toContain(`Not available here`);
    expect(element.querySelector(`[tabindex="0"]`)).toBeNull();
});

/* THE CHIPS ARE THE SHARED CONTROL NOW (PickerRunSettings), and this is what "unified" has to mean on screen. */
it(`asks the thinking question with the shared chip`, () => {
    const { element, conversation } = mount(CEILING);

    expect(chips(element)).toEqual({ "Extended thinking": conversation.selection.thinking.value });
});

// The chip is the whole control: pressing it writes the opposite of what it is showing, and nothing else.
it(`writes the chip's opposite straight through to the conversation`, async () => {
    const { element, conversation } = mount(CEILING);
    expect(chips(element)[`Extended thinking`]).toBe(false);

    chip(element, `Extended thinking`).click();
    await nextTick();

    expect(conversation.selection.apply).toHaveBeenCalledWith({ kind: `setThinking`, thinking: true });
    // No third state to land in: the only two calls this chip can make are the two booleans.
    expect(conversation.selection.apply).toHaveBeenCalledTimes(1);
});

// Speed is the second Claude switch and the same chip, offered only where the catalog publishes the badge.
it(`asks the speed question with the same chip, and writes the press through`, async () => {
    providerModels.value = { ...providerModels.value, claude: [{ label: `A model`, value: MODEL, badges: [`fast`] }] };
    const { element, conversation } = mount(CEILING);

    expect(chips(element)).toEqual({ "Extended thinking": false, "Fast speed": false });

    chip(element, `Fast speed`).click();
    await nextTick();
    expect(conversation.selection.apply).toHaveBeenCalledWith({ kind: `setFast`, fast: true });
});

/* THE METER IS THE ONE CONTROL THIS PICKER LEAVES OUT (`effortRow`), and not a preference: ComposerEffort draws it beside the model pill. */
it(`leaves the reasoning-effort row to the meter beside the model pill`, () => {
    const { element, conversation } = mount(CEILING);

    // The shared control IS drawn here; the meter is the one part of it drawn without.
    expect(chips(element)).toEqual({ "Extended thinking": false });
    // And the rungs exist for this model, so the row is withheld rather than empty.
    expect(effortsFor(CEILING.provider, MODEL, conversation.selection.thinking.value).length).toBeGreaterThan(1);
    expect(element.textContent).not.toContain(`Reasoning effort`);
});

/* AND `hasContent` COUNTS THAT OMISSION, or the footer would draw its rule and its 12px of padding around nothing. */
it(`draws no footer at all when the withheld meter was the only row left`, () => {
    expect(limitsOf(BARE)).toEqual([]);

    const { element, conversation } = mount(BARE);

    expect(effortsFor(BARE.provider, MODEL, conversation.selection.thinking.value).length).toBeGreaterThan(1);
    expect(element.textContent).toBe(``);
});

/* AUTO IS A MODE, NOT A MODEL, and the two facts that make it one: it is always offered where it can act, and while
   it is armed the footer answers nothing about the model underneath — that model is only the fallback. */

const leadLabels = (): string[] => ((pickerProps.value[`lead-rows`] ?? []) as { label: string }[]).map((row) => row.label);

it(`offers Auto on a chat with nothing sent, gated by no setting of the sandbox's`, () => {
    mount(CEILING);

    expect(leadLabels()).toEqual([`Auto`]);
});

// chatRoute.ts reads the OPENING message and never asks again, so on a chat already under way the row would arm a
// question nothing will answer and disarm itself at the next send.
it(`withdraws Auto once the chat has a turn behind it`, () => {
    mount(CEILING, { sent: 1 });

    expect(leadLabels()).toEqual([]);
});

it(`ticks Auto rather than a model row while it is armed`, () => {
    mount(CEILING, { auto: true });

    expect(pickerProps.value[`lead-selected`]).toBe(`auto:`);
});

// The whole bug this replaced: the footer went on offering accounts, thinking and this runtime's limits for a model
// Auto had not chosen yet, so the panel answered questions about the wrong model.
it(`says what Auto will do and withholds every control over the model underneath`, () => {
    const { element } = mount(ROUTED, { auto: true });

    expect(limitsOf(ROUTED).length).toBeGreaterThan(1);
    expect(element.textContent).toContain(`Your first message picks what this chat runs on`);
    expect(element.textContent).toContain(`Choose which model does the reading`);
    expect(element.textContent).not.toContain(`Not available here`);
    expect(chips(element)).toEqual({});
});
