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
vi.mock(`../composables/chat/pickerAccounts`, () => ({ usePickerAccounts: () => ({ hasContent: computed(() => true) }) }));

const { requestModelPick, settleModelPick } = await import("../composables/chat/hostModelPicker");
const { default: HostPickerBody } = await import("./HostPickerBody.vue");

let app: App | undefined;
const mount = (): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(HostPickerBody) });
    app.mount(element);
    return element;
};

afterEach(() => {
    settleModelPick(undefined);
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
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
