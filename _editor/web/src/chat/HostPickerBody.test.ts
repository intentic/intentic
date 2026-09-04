// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick } from "vue";

vi.mock(`./ModelPicker.vue`, () => ({
    default: defineComponent({
        setup:
            (_props, { emit, slots }) =>
            () =>
                h(`div`, [
                    h(
                        `button`,
                        {
                            onClick: () => emit(`pick`, { provider: `claude`, value: `claude-opus-4-6`, label: `Claude Opus 4.6` }),
                        },
                        `Pick model`,
                    ),
                    slots[`footer`]?.(),
                ]),
    }),
}));
vi.mock(`./PickerAccounts.vue`, () => ({
    default: defineComponent({
        setup:
            (_props, { emit }) =>
            () =>
                h(`button`, { onClick: () => emit(`selectAccount`, `second-account`) }, `Switch account`),
    }),
}));
/* The meter's own drawing is the composer's control and is tested there; this stub keeps the one thing this file
 * is about — WHICH rungs the panel hands it, and what the panel does with the one it emits — by drawing a button
 * per rung under the tier's own name. */
vi.mock(`./EffortMeter.vue`, () => ({
    default: defineComponent({
        props: { efforts: { type: Array, default: () => [] } },
        emits: [`pick`],
        setup:
            (props, { emit }) =>
            () =>
                h(
                    `span`,
                    (props.efforts as { label: string; value: string }[]).map((option) =>
                        h(`button`, { key: option.value, onClick: () => emit(`pick`, option.value) }, option.label),
                    ),
                ),
    }),
}));
vi.mock(`../composables/chat/pickerAccounts`, () => ({ usePickerAccounts: () => ({ hasContent: computed(() => true) }) }));

const { requestModelPick, settleModelPick } = await import("../composables/chat/hostModelPicker");
const { providerModels } = await import("../composables/chat/providerCatalog");
const { default: HostPickerBody } = await import("./HostPickerBody.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(HostPickerBody) });
    app.mount(element);
    return element;
};

// The rung the panel offered, by the word the app puts on it.
const rung = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((button) => button.textContent === label);

afterEach(() => {
    settleModelPick(undefined);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    providerModels.value = { ...providerModels.value, claude: [] };
});

it(`keeps an account switch open and carries it into the eventual model pick`, async () => {
    const anchor = document.createElement(`button`);
    const settled = vi.fn();
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        account: `first-account`,
        harness: `claude-code`,
    });
    void result.then(settled);
    const element = mount();
    const [pickModel, switchAccount] = element.querySelectorAll<HTMLButtonElement>(`button`);

    switchAccount!.click();
    await nextTick();
    expect(settled).not.toHaveBeenCalled();

    pickModel!.click();
    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: `Claude Opus 4.6`,
        account: `second-account`,
        harness: `claude-code`,
    });
});

/* THE TIER IS A SETTING OF THE ANSWER, not the answer: choosing a rung leaves the panel open (you have not said
 * which model yet), and the model row that closes it carries the rung with it. Without that, the caret on every
 * "Fix with agent" could re-point the model and not what it costs. */
it(`keeps an effort pick open and carries it into the eventual model pick`, async () => {
    const anchor = document.createElement(`button`);
    const settled = vi.fn();
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseEffort: true });
    void result.then(settled);
    const element = mount();

    rung(element, `X-High`)!.click();
    await nextTick();
    expect(settled).not.toHaveBeenCalled();

    element.querySelector<HTMLButtonElement>(`button`)!.click();
    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: `Claude Opus 4.6`,
        effort: `xhigh`,
    });
});

/* THE TOP RUNG IS REACHABLE HERE, which is the whole reason this panel draws the row: a run started from a red
 * pipeline has no composer beside it to switch extended thinking on with. It used to read this selection's
 * absent thinking as thinking switched OFF, which is the one pair Anthropic refuses, so Max was missing from
 * every "Fix with agent" caret while the model's own catalog published it. */
it(`offers the model's top tier to a run that pinned no thinking to refuse it`, async () => {
    providerModels.value = {
        ...providerModels.value,
        claude: [{ label: `Claude Opus 4.6`, value: `claude-opus-4-6`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }],
    };
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseEffort: true });
    const element = mount();

    rung(element, `Max`)!.click();
    await nextTick();
    element.querySelector<HTMLButtonElement>(`button`)!.click();

    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: `Claude Opus 4.6`,
        effort: `max`,
    });
});

// The way back to the model's own default, which is a state rather than a rung: the pick then names no tier at
// all and the turn goes out without one.
it(`drops the tier again when the run is set back to the model's own default`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, effort: `high`, chooseEffort: true });
    const element = mount();
    const buttons = element.querySelectorAll<HTMLButtonElement>(`button`);
    const clear = [...buttons].find((button) => button.getAttribute(`aria-label`) === `Take this model's own default effort`);

    clear!.click();
    await nextTick();
    buttons[0]!.click();

    await expect(result).resolves.toEqual({ provider: `claude`, model: `claude-opus-4-6`, label: `Claude Opus 4.6` });
});

/* THE ROW IS THE RUN BUTTONS', not the panel's. The chat sets its effort in the composer, and the automations
 * and workflow-step forms store a model with no tier field behind it: for those callers a meter would be a
 * control whose answer is dropped on the floor, which is worse than no control at all. */
it(`offers no tier to a caller that has not said it carries one`, () => {
    const anchor = document.createElement(`button`);
    void requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6` });
    const element = mount();

    expect([...element.querySelectorAll(`button`)].map((button) => button.textContent)).toEqual([`Pick model`, `Switch account`]);
});
