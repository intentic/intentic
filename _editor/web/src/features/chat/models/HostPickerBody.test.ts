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

/* The model list itself is the app's own panel and has its own suite; here it is a stub that renders the two
 * slots and can answer with a row or with the keyboard's submit. */
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
const { default: HostPickerBody } = await import("./HostPickerBody.vue");

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

/* THE ROW SELECTS, THE BAR ANSWERS. Both halves matter: a list row that settled the promise made every other
 * control in the panel a setting you could only apply by afterwards clicking a model you had already chosen. */
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

/* AN ACCOUNT BELONGS TO THE PROVIDER IT WAS CHOSEN UNDER. Re-pointing across providers has to drop it (and the
 * harness with it), or the run would be pinned to a credential the new provider has never heard of. */
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

/* THE TIER IS A SETTING OF THE ANSWER, not the answer: choosing a rung leaves the panel open, and the press that
 * ends it carries the rung. Without that, the caret on every "Fix with agent" could re-point the model and not
 * what it costs. */
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
    });
});

// The top rung is reachable here because a run started from a red pipeline has no composer beside it to
// switch thinking on.
it(`offers the model's top tier to a run that pinned no thinking to refuse it`, async () => {
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
    });
});

/* AND SWITCHING THINKING OFF TAKES IT AWAY AGAIN, on the way out as well as on the meter: Claude refuses `max`
 * beside thinking explicitly disabled, so the answer is the tier the run will actually spend rather than the one
 * the reader chose before they touched the other control. */
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

    button(element, `Off`)!.click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        effort: `high`,
        thinking: false,
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

    button(element, `Fast`)!.click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({
        provider: `claude`,
        model: `claude-opus-4-6`,
        label: modelLabelFor(`claude`, `claude-opus-4-6`),
        harness: `claude-code`,
        fast: true,
    });
});

// The way back to the model's own default, which is a state rather than a rung: the answer then names no tier at
// all and the turn goes out without one.
it(`drops the tier again when the run is set back to the model's own default`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({
        anchor,
        provider: `claude`,
        model: `claude-opus-4-6`,
        effort: `high`,
        chooseRun: true,
        action: `Fix with agent`,
    });
    const element = mount();

    [...element.querySelectorAll<HTMLButtonElement>(`button`)]
        .find((candidate) => candidate.getAttribute(`aria-label`) === `Take this model's own default effort`)!
        .click();
    await nextTick();
    button(element, `Fix with agent`)!.click();

    await expect(result).resolves.toEqual({ provider: `claude`, model: `claude-opus-4-6`, label: modelLabelFor(`claude`, `claude-opus-4-6`) });
});

/* LEAVING IS A CANCEL, WHOLE, and this is the behaviour that flipped. It used to answer with whatever had been
 * staged, so backing out of an effort change armed it instead: the tier stuck on the caller's next run and the
 * only way to undo it was to open the panel again and clear it. The rows can write through freely precisely
 * because Escape now undoes all of them at once. */
it(`answers with nothing when the panel is dismissed after staging`, async () => {
    const anchor = document.createElement(`button`);
    const result = requestModelPick({ anchor, provider: `claude`, model: `claude-opus-4-6`, chooseRun: true, action: `Fix with agent` });
    const element = mount();

    button(element, `X-High`)!.click();
    await nextTick();
    dismissModelPick();

    await expect(result).resolves.toBeUndefined();
});

/* THE ROWS ARE THE RUN CALLERS', not the panel's. The chat sets its effort in the composer, and a workflow step
 * stores a pair and an account: for those a meter would be a control whose answer is dropped on the floor, which
 * is worse than no control at all. */
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

/* NOTHING CHOSEN IS A REAL STATE the panel opens in — an automation rung added past the end of its ladder
 * arrives with a blank pair — and there is no such thing as half an entry, so the press is refused until the
 * list has been answered. */
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
