// @vitest-environment jsdom
// Tests that the picker discloses what a runtime can't do (from the record, limitationsOf) without spending
// permanent space: one row with a count, full text on hover. Not about which words the record chose. And that
// the run settings under it ARE the shared control (PickerRunSettings), drawn without the meter this surface
// already keeps beside its model pill.
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
const { providerModels } = await import("../accounts/providerCatalog");
const { effortsFor } = await import("./effortScale");

// Grok native, the weakest runtime (something to disclose); Claude Code, the ceiling; both from the contract.
const ROUTED = { provider: `grok`, harness: `native` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const CEILING = { provider: `claude`, harness: `claude-code` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
// The same ceiling under a provider with no Claude knobs: nothing to disclose, no thinking, no fast speed.
const BARE = { provider: `codex`, harness: `claude-code` } as const satisfies { provider: AgentProvider; harness: AgentHarness };
const limitsOf = (pair: { provider: AgentProvider; harness: AgentHarness }): string[] => limitationsOf(capabilitiesOf(pair.provider, pair.harness));

// The model every mount stands on, so a badge can be published against it.
const MODEL = `a-model`;

// The conversation as this panel reads it: just the refs it binds and the writes it makes, no transcript machinery.
const conversationOf = (pair: { provider: AgentProvider; harness: AgentHarness }): Conversation =>
    ({
        provider: ref(pair.provider),
        harness: ref(pair.harness),
        model: ref(MODEL),
        thinking: ref(false),
        fast: ref(false),
        effort: computed(() => ``),
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
        setEffort: vi.fn(),
        setThinking: vi.fn(),
        setFast: vi.fn(),
        setTierHold: vi.fn(),
    }) as unknown as Conversation;

let app: App | undefined;
// The conversation goes back with the element: the run-settings rows are asserted by the writes they make on it.
const mount = (pair: { provider: AgentProvider; harness: AgentHarness } = ROUTED): { element: HTMLElement; conversation: Conversation } => {
    const element = document.createElement(`div`);
    document.body.append(element);
    const held = conversationOf(pair);
    app = createApp({ render: () => h(ChatModelPicker, { conversation: held }) });
    app.component(`Icon`, IconStub);
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

/* THE CHIPS ARE THE SHARED CONTROL NOW (PickerRunSettings), and this is what "unified" has to mean on screen:
 * this panel's own two chips, drawn from one component, so the shell picker and the settings page ask with the
 * same instrument instead of a labelled row carrying a third stop. Thinking alone until the catalog publishes
 * a fast badge — a control that appears with the model beats one greyed under an explanation nobody reads. */
it(`asks the thinking question with the shared chip`, () => {
    const { element, conversation } = mount(CEILING);

    expect(chips(element)).toEqual({ "Extended thinking": conversation.thinking.value });
});

// The chip is the whole control: pressing it writes the opposite of what it is showing, and nothing else.
it(`writes the chip's opposite straight through to the conversation`, async () => {
    const { element, conversation } = mount(CEILING);
    expect(chips(element)[`Extended thinking`]).toBe(false);

    chip(element, `Extended thinking`).click();
    await nextTick();

    expect(conversation.setThinking).toHaveBeenCalledWith(true);
    // No third state to land in: the only two calls this chip can make are the two booleans.
    expect(conversation.setThinking).toHaveBeenCalledTimes(1);
});

// Speed is the second Claude switch and the same chip, offered only where the catalog publishes the badge.
it(`asks the speed question with the same chip, and writes the press through`, async () => {
    providerModels.value = { ...providerModels.value, claude: [{ label: `A model`, value: MODEL, badges: [`fast`] }] };
    const { element, conversation } = mount(CEILING);

    expect(chips(element)).toEqual({ "Extended thinking": false, "Fast speed": false });

    chip(element, `Fast speed`).click();
    await nextTick();
    expect(conversation.setFast).toHaveBeenCalledWith(true);
});

/* THE METER IS THE ONE CONTROL THIS PICKER LEAVES OUT (`effortRow`), and not a preference: ComposerEffort draws
 * it beside the model pill, an inch from the chevron that opens this panel, so the row would be the same
 * control twice on one surface. */
it(`leaves the reasoning-effort row to the meter beside the model pill`, () => {
    const { element, conversation } = mount(CEILING);

    // The shared control IS drawn here; the meter is the one part of it drawn without.
    expect(chips(element)).toEqual({ "Extended thinking": false });
    // And the rungs exist for this model, so the row is withheld rather than empty.
    expect(effortsFor(CEILING.provider, MODEL, conversation.thinking.value).length).toBeGreaterThan(1);
    expect(element.textContent).not.toContain(`Reasoning effort`);
});

/* AND `hasContent` COUNTS THAT OMISSION, or the footer would draw its rule and its 12px of padding around
 * nothing: a provider with no Claude knobs and nothing to disclose has only the withheld meter to offer. */
it(`draws no footer at all when the withheld meter was the only row left`, () => {
    expect(limitsOf(BARE)).toEqual([]);

    const { element, conversation } = mount(BARE);

    expect(effortsFor(BARE.provider, MODEL, conversation.thinking.value).length).toBeGreaterThan(1);
    expect(element.textContent).toBe(``);
});
