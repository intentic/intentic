// @vitest-environment jsdom
//
// THE SHELL PICKER AS A FORM: every row STAGES, and the bar at the bottom is the only thing that answers.
//
// Three claims, and they are the whole redesign. A model row no longer settles the promise — it moves the
// selection, exactly as the account and tier rows always did, so the panel has one grammar instead of two. The
// commit bar carries the caller's own verb and hands back everything staged, so configuring a run and starting
// it are one press rather than a dismissal followed by a second click. And leaving the panel any other way is a
// plain cancel: the version that answered on dismissal meant a user who dragged the effort meter and changed
// their mind had armed the tier they were backing out of.
import { afterEach, expect, it, vi } from "vitest";
import { type App, computed, createApp, defineComponent, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

/* The model list itself is the app's own panel and has its own suite. */
vi.mock(`./ModelPicker.vue`, () => ({
    default: defineComponent({
        setup:
            (_props, { emit, slots }) =>
            () =>
                h(`div`, [
                    h(
                        `button`,
                        {
                            onClick: () =>
                                emit(`pick`, { provider: `claude`, value: `claude-opus-4-6`, label: modelLabelFor(`claude`, `claude-opus-4-6`) }),
                        },
                        `Pick model`,
                    ),
                    h(
                        `button`,
                        { onClick: () => emit(`pick`, { provider: `codex`, value: `gpt-5.6`, label: modelLabelFor(`codex`, `gpt-5.6`) }) },
                        `Pick codex`,
                    ),
                    h(`button`, { onClick: () => emit(`submit`) }, `Keyboard submit`),
                    slots[`footer`]?.(),
                    slots[`commit`]?.(),
                ]),
    }),
}));
vi.mock(`../accounts/PickerAccounts.vue`, () => ({
    default: defineComponent({
        setup:
            (_props, { emit }) =>
            () =>
                h(`button`, { onClick: () => emit(`selectAccount`, `second-account`) }, `Switch account`),
    }),
}));
// The meter itself is tested elsewhere; this stub checks which rungs the panel hands it and what it emits.
vi.mock(`../composer/EffortMeter.vue`, () => ({
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
// The kit's action button is PrimeVue's underneath and wants its plugin; the commit bar only needs it to carry a
// label, a disabled state and a click.
vi.mock(`@intentic/ui`, async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    Button: defineComponent({
        props: { label: String, disabled: Boolean },
        setup:
            (props, { attrs }) =>
            () =>
                h(`button`, { disabled: props.disabled, onClick: attrs[`onClick`] }, props.label),
    }),
}));
vi.mock(`../accounts/pickerAccounts`, () => ({ usePickerAccounts: () => ({ hasContent: computed(() => true) }) }));

const { dismissModelPick, modelRequest, requestModelPick, settleModelPick } = await import("./hostModelPicker");
const { modelLabelFor, providerModels } = await import("../accounts/providerCatalog");
const { DEFAULT_EFFORT, DEFAULT_THINKING, defaultRunSettings } = await import("./pickerRunSettings");
const { default: HostPickerBody } = await import("./HostPickerBody.vue");

/* WHAT A `chooseRun` ANSWER CARRIES BESIDES THE TIER THE TEST IS ABOUT. */
const { effort: _seededEffort, ...SEEDED_KNOBS } = defaultRunSettings();

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(HostPickerBody) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

// A control by the word on it: the rungs the meter offered, the thinking stops, and the commit bar's own verb.
const button = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll<HTMLButtonElement>(`button`)].find((candidate) => candidate.textContent === label);

afterEach(() => {
    settleModelPick(undefined);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    providerModels.value = { ...providerModels.value, claude: [] };
});

/* THE ROW SELECTS, THE BAR ANSWERS. */
it(`selects a model row without settling, and answers when the bar is pressed`, async () => {
    const anchor = document.createElement(`button`);
    const settled = vi.fn();
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-haiku-4-5`, action: `Fix with agent` });
    void result.then(settled);
    const element = mount();

    button(element, `Pick model`)!.click();
    await nextTick();
    expect(settled).not.toHaveBeenCalled();
    // Selected, not answered: the panel is now standing on the row that was clicked.
    expect(modelRequest.value?.model).toBe(`claude-opus-4-6`);

    button(element, `Fix with agent`)!.click();
    await expect(result).resolves.toEqual({ provider: `claude`, model: `claude-opus-4-6`, label: modelLabelFor(`claude`, `claude-opus-4-6`) });
});

// ⌘/Ctrl-Enter is the same press, from the search field the panel opens focused in.
it(`answers on the keyboard's submit too`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, action: `Run chore` });
    const element = mount();

    button(element, `Keyboard submit`)!.click();

    await expect(result).resolves.toEqual({ provider: `claude`, model: `claude-opus-4-6`, label: modelLabelFor(`claude`, `claude-opus-4-6`) });
});

it(`carries an account switch into the answer`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        account: `first-account`,
        harness: `claude-code`,
        action: `Fix with agent`,
    });
    const element = mount();

    button(element, `Switch account`)!.click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        account: `second-account`,
        harness: `claude-code`,
    });
});

/* AN ACCOUNT BELONGS TO THE PROVIDER IT WAS CHOSEN UNDER. */
it(`drops the account and harness when the selection moves to another provider`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        account: `first-account`,
        harness: `claude-code`,
        action: `Fix with agent`,
    });
    const element = mount();

    button(element, `Pick codex`)!.click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({ provider: `codex`, model: `gpt-5.6`, label: modelLabelFor(`codex`, `gpt-5.6`) });
});

/* THE TIER IS A SETTING OF THE ANSWER, not the answer: choosing a rung leaves the panel open, and the press that ends it carries the rung. */
it(`carries the tier into the answer`, async () => {
    const anchor = document.createElement(`button`);
    const settled = vi.fn();
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseRun: true, action: `Fix with agent` });
    void result.then(settled);
    const element = mount();

    button(element, `X-High`)!.click();
    await nextTick();
    expect(settled).not.toHaveBeenCalled();

    button(element, `Fix with agent`)!.click();
    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        effort: `xhigh`,
        ...SEEDED_KNOBS,
    });
});

/* THE PANEL OPENS ON A STATE, NEVER ON AN ABSENCE. */
it(`opens a run's settings on the defaults and answers with them untouched`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseRun: true, action: `Fix with agent` });
    const element = mount();

    expect(modelRequest.value).toMatchObject(defaultRunSettings());

    button(element, `Fix with agent`)!.click();
    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        ...defaultRunSettings(),
    });
});

// The top rung is reachable because the seed leaves thinking ON: Claude refuses `max` only beside a thinking
// flag explicitly set to false, which is now the one way that can happen.
it(`offers the model's top tier to a run whose thinking the reader never switched off`, async () => {
    providerModels.value = {
        ...providerModels.value,
        claude: [{ label: modelLabelFor(`claude`, `claude-opus-4-6`), value: `claude-opus-4-6`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }],
    };
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseRun: true, action: `Fix with agent` });
    const element = mount();

    button(element, `Max`)!.click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        effort: `max`,
        ...SEEDED_KNOBS,
    });
});

/* AND SWITCHING THINKING OFF TAKES IT AWAY AGAIN, on the way out as well as on the meter: Claude refuses `max` beside thinking explicitly disabled. */
it(`repairs a top-tier pick when thinking is switched off under it`, async () => {
    providerModels.value = {
        ...providerModels.value,
        claude: [{ label: modelLabelFor(`claude`, `claude-opus-4-6`), value: `claude-opus-4-6`, efforts: [`low`, `medium`, `high`, `xhigh`, `max`] }],
    };
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        effort: `max`,
        chooseRun: true,
        action: `Fix with agent`,
    });
    const element = mount();

    // The chip opens lit (the seed leaves thinking on), so one press is what switches it off.
    button(element, `Extended thinking`)!.click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        effort: `high`,
        thinking: false,
        fast: false,
    });
});

// Speed is a price, so it rides the answer like the tier does.
it(`carries fast speed into the answer`, async () => {
    providerModels.value = {
        ...providerModels.value,
        claude: [{ label: modelLabelFor(`claude`, `claude-opus-4-6`), value: `claude-opus-4-6`, badges: [`fast`] }],
    };
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        harness: `claude-code`,
        chooseRun: true,
        action: `Fix with agent`,
    });
    const element = mount();

    button(element, `Fast speed`)!.click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        harness: `claude-code`,
        ...defaultRunSettings(),
        fast: true,
    });
});

/* An unanswered run setting remains unset. */
it(`answers with all three run settings even when the caller named none and the reader pressed nothing`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseRun: true, action: `Fix with agent` });
    const element = mount();

    button(element, `Fix with agent`)!.click();

    const answer = (await result)!;
    expect(Object.keys(answer)).toEqual(expect.arrayContaining([`effort`, `thinking`, `fast`]));
    expect([answer.effort, answer.thinking, answer.fast]).toEqual([DEFAULT_EFFORT, DEFAULT_THINKING, false]);
});

/* AND THERE IS NO WAY BACK TO "THE MODEL'S OWN DEFAULT" ON SCREEN EITHER, because the panel never offers that state in the first place. */
it(`offers no way to unset a run setting once the panel has shown one`, () => {
    const anchor = document.createElement(`button`);
    void requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        effort: `high`,
        chooseRun: true,
        action: `Fix with agent`,
    });
    const element = mount();

    // The two switches are chips and nothing else in the panel is pressable except the list and the bar.
    expect([...element.querySelectorAll(`button[aria-pressed]`)].map((chip) => chip.textContent)).toEqual([`Extended thinking`]);
    expect([...element.querySelectorAll(`button`)].map((candidate) => candidate.getAttribute(`aria-label`))).not.toContain(
        `Take this model's own default effort`,
    );
});

/* LEAVING IS A CANCEL, WHOLE, and this is the behaviour that flipped. */
it(`answers with nothing when the panel is dismissed after staging`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseRun: true, action: `Fix with agent` });
    const element = mount();

    button(element, `X-High`)!.click();
    await nextTick();
    dismissModelPick();

    await expect(result).resolves.toBeUndefined();
});

/* THE ROWS ARE THE RUN CALLERS', not the panel's. */
it(`offers no run settings to a caller that has not said it carries them`, () => {
    const anchor = document.createElement(`button`);
    void requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6` });
    const element = mount();

    expect([...element.querySelectorAll(`button`)].map((candidate) => candidate.textContent)).toEqual([
        `Pick model`,
        `Pick codex`,
        `Keyboard submit`,
        `Switch account`,
        // The default verb, for a caller that is storing the answer rather than spending it.
        `Use this model`,
    ]);
});

/* NOTHING CHOSEN IS A REAL STATE the panel opens in — an automation rung added past the end of its ladder arrives with a blank pair. */
it(`refuses the press until a model has been chosen`, async () => {
    const anchor = document.createElement(`button`);
    const settled = vi.fn();
    const result = requestModelPick({ anchor, provider: ``, model: ``, action: `Use this model` });
    void result.then(settled);
    const element = mount();

    const commit = button(element, `Use this model`)!;
    expect(commit.disabled).toBe(true);
    commit.click();
    await nextTick();
    expect(settled).not.toHaveBeenCalled();

    button(element, `Pick model`)!.click();
    await nextTick();
    expect(button(element, `Use this model`)!.disabled).toBe(false);
});

/* OVER AN ATTEMPT, THE BAR IS ABOUT THE ATTEMPT. */
it(`names the attempt and ends in Continue or Start over, and the answer says which`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        action: `Fix with agent`,
        attempt: { summary: `Attempt 1 · Opus 4.6 · stopped · 3 files on its branch`, continuable: true },
    });
    const element = mount();

    expect(button(element, `Fix with agent`)).toBeUndefined();
    expect(element.textContent).toContain(`Attempt 1 · Opus 4.6 · stopped · 3 files on its branch`);
    button(element, `Start over`)!.click();
    await expect(result).resolves.toMatchObject({ provider: `claude`, model: `claude-opus-4-6`, resume: `start-over` });
});

it(`Continue is the keyboard's press over an attempt that can be continued`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        attempt: { summary: `Attempt 2 · Opus 4.6 · agent failed`, continuable: true },
    });
    const element = mount();

    button(element, `Keyboard submit`)!.click();
    await expect(result).resolves.toMatchObject({ resume: `continue` });
});

// An attempt still working or parked is steered from its own chat; from here the only decision is to start over.
it(`an attempt still in play offers Start over alone, and the keyboard means that`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        attempt: { summary: `Attempt 1 · Opus 4.6 · agent working`, continuable: false },
    });
    const element = mount();

    expect(button(element, `Continue`)).toBeUndefined();
    expect(button(element, `Start over`)?.textContent).toBe(`Start over`);
    button(element, `Keyboard submit`)!.click();
    await expect(result).resolves.toMatchObject({ resume: `start-over` });
});

// Without an attempt the bar is the caller's, and the answer carries no verb to misread.
it(`a bar with no attempt answers without a resume verb`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, action: `Run chore` });
    const element = mount();
    button(element, `Run chore`)!.click();
    const answer = await result;
    expect(answer).toMatchObject({ provider: `claude`, model: `claude-opus-4-6` });
    expect(Object.keys(answer ?? {})).not.toContain(`resume`);
});
