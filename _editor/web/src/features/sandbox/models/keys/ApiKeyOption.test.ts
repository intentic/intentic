// An API key beside a provider's sign-in (ApiKeyOption.vue): one quiet line until asked for, the cost said before the
// field, and a key the vendor lists no models for taken back out rather than left as a dead provider in the picker.
import "@intentic/testing/dom";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { ui as recipes } from "@intentic/ui/recipes";
import { IconStub } from "@intentic/ui/testing";
import { installI18n } from "@intentic/ui/i18n";

interface Held {
    id: string;
    status: { state: string };
}
const held = ref<Held[]>([]);
let answerState = `active`;
const add = jest.fn(async (input: { id: string }) => void held.value.push({ id: input.id, status: { state: answerState } }));
const remove = { mutateAsync: jest.fn(async (id: string) => void (held.value = held.value.filter((entry) => entry.id !== id))) };
const refetch = jest.fn(async () => ({ data: { capabilities: held.value } }));

jest.mock(`../../../../models/capabilities/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities: held, add, remove, refetch }) }));
jest.mock(`../../../../models/conversations/accounts/useChat-accounts`, () => ({ refreshConnections: jest.fn(async () => undefined) }));
jest.mock(`@intentic/ui`, () => ({
    ui: recipes,
    Icon: defineComponent({ render: () => h(`i`) }),
    RowNote: defineComponent({ setup: (_props, { slots }) => () => h(`div`, slots[`default`]?.()) }),
    Button: defineComponent({
        props: { label: String, disabled: Boolean, loading: Boolean },
        emits: [`click`],
        setup: (props, { emit }) => () => h(`button`, { disabled: props.disabled, onClick: () => emit(`click`) }, props.label),
    }),
}));

let app: App | undefined;
afterEach(() => {
    app?.unmount();
    app = undefined;
    held.value = [];
    answerState = `active`;
    add.mockClear();
    remove.mutateAsync.mockClear();
});

const mount = async (provider: string, onAdded?: (endpoint: string, label: string) => void, another = false): Promise<HTMLElement> => {
    const { default: ApiKeyOption } = await import(`./ApiKeyOption.vue`);
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp(defineComponent({ render: () => h(ApiKeyOption, { provider, onAdded, another }) }));
    app.component(`Icon`, IconStub);
    installI18n(app);
    app.mount(host);
    return host;
};

const press = (host: HTMLElement, label: string): void => [...host.querySelectorAll(`button`)].find((button) => button.textContent?.includes(label))!.click();
const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

const openWithKey = async (host: HTMLElement, key: string): Promise<void> => {
    press(host, `Use an API key from Anthropic instead`);
    await nextTick();
    const field = host.querySelector<HTMLInputElement>(`input[name="providerApiKey"]`)!;
    field.value = key;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

it(`is one quiet line until asked for, and says nothing for a provider with no key to offer`, async () => {
    const host = await mount(`claude`);
    expect(host.textContent?.trim()).toBe(`Use an API key from Anthropic instead`);
    expect(host.querySelector(`input`)).toBeNull();
    app?.unmount();
    expect((await mount(`cursor`)).textContent?.trim()).toBe(``);
});

it(`says what a key costs before asking for one, and keeps the key masked`, async () => {
    const host = await mount(`claude`);
    await openWithKey(host, ``);
    expect(host.textContent).toContain(`Paid per token to Anthropic, apart from any plan.`);
    expect(host.textContent).toContain(`spending limit`);
    expect(host.querySelector<HTMLInputElement>(`input[name="providerApiKey"]`)?.type).toBe(`password`);
    expect([...host.querySelectorAll(`a`)].map((link) => link.getAttribute(`href`))).toEqual([
        `https://www.anthropic.com/pricing#api`,
        `https://console.anthropic.com/settings/keys`,
    ]);
});

it(`adds the key as an endpoint at the vendor's own address, and hands the page what it became`, async () => {
    const added = jest.fn();
    const host = await mount(`claude`, added);
    await openWithKey(host, `  sk-ant-test-123  `);
    press(host, `Add key`);
    await flush();
    expect(add).toHaveBeenCalledWith({
        id: `anthropic`,
        kind: `endpoint`,
        config: { baseUrl: `https://api.anthropic.com`, protocol: `anthropic`, apiKey: `sk-ant-test-123` },
    });
    expect(added).toHaveBeenCalledWith(expect.any(String), `Anthropic`);
    expect(host.querySelector(`input`), `the form stayed open after the key landed`).toBeNull();
});

it(`takes back a key the vendor lists no models for, and says so at the field`, async () => {
    answerState = `error`;
    const added = jest.fn();
    const host = await mount(`claude`, added);
    await openWithKey(host, `sk-ant-wrong`);
    press(host, `Add key`);
    await flush();
    expect(remove.mutateAsync).toHaveBeenCalledWith(`anthropic`);
    expect(added).not.toHaveBeenCalled();
    expect(host.querySelector(`[role="alert"]`)?.textContent).toContain(`Anthropic didn't accept this key`);
    expect(host.querySelector<HTMLInputElement>(`input[name="providerApiKey"]`)?.value, `the key to correct was cleared`).toBe(`sk-ant-wrong`);
});

it(`offers one more key on a card that holds one, and numbers the endpoint it becomes`, async () => {
    held.value = [{ id: `anthropic`, status: { state: `active` } }];
    const host = await mount(`claude`, undefined, true);
    expect(host.textContent?.trim()).toBe(`Add another Anthropic API key`);
    press(host, `Add another Anthropic API key`);
    await nextTick();
    const field = host.querySelector<HTMLInputElement>(`input[name="providerApiKey"]`)!;
    field.value = `sk-ant-second`;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
    press(host, `Add key`);
    await flush();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: `anthropic-2`, config: expect.objectContaining({ apiKey: `sk-ant-second` }) }));
});
