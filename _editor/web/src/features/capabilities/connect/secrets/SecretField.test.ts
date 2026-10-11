// jsdom: the shared credential field must stay shrinkable without losing masking, multiline or collect behavior.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { IconStub } from "@intentic/ui/testing";
import { type App, createApp, h, nextTick, ref } from "vue";

const set = jest.fn<(input: { key: string; value: string }) => Promise<void>>().mockResolvedValue(undefined);
const setCapability = jest.fn<(input: { id: string; value: string }) => Promise<void>>().mockResolvedValue(undefined);
jest.mock(`./useSecrets`, () => ({ useSecrets: () => ({ set: { mutateAsync: set } }) }));
jest.mock(`../useCapabilities`, () => ({ useCapabilitySecret: () => ({ mutateAsync: setCapability }) }));
const { default: SecretField } = await import(`./SecretField.vue`);

let app: App | undefined;
const draft = ref(``);
const mount = (props: { multiline?: boolean; collect?: boolean; cancellable?: boolean } = {}): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({
        render: () =>
            h(SecretField, {
                secretKey: `DEMO_KEY`,
                ...props,
                modelValue: draft.value,
                "onUpdate:modelValue": (value: string) => {
                    draft.value = value;
                },
            }),
    });
    app.component(`Icon`, IconStub);
    app.mount(host);
    return host;
};

beforeEach(() => {
    draft.value = ``;
    set.mockClear();
    setCapability.mockClear();
});
afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`keeps standalone save working from the shrinkable password field's Enter key`, async () => {
    const host = mount({ cancellable: true });
    const input = host.querySelector<HTMLInputElement>(`input`)!;
    expect(input.classList.contains(`min-w-0`)).toBe(true);
    expect(input.parentElement?.classList.contains(`flex-wrap`)).toBe(true);
    expect(input.getAttribute(`aria-label`)).toBe(`Paste the value for DEMO_KEY`);
    input.value = `test-value`;
    input.dispatchEvent(new Event(`input`));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true, cancelable: true }));
    await waitFor(() => expect(set).toHaveBeenCalledWith({ key: `DEMO_KEY`, value: `test-value` }));
    await waitFor(() => expect(draft.value).toBe(``));
    expect(setCapability).not.toHaveBeenCalled();
    expect(host.querySelector(`button[aria-label="Cancel"]`)).not.toBeNull();
});

it(`keeps multiline values labelled, shrinkable and masked until explicitly shown`, async () => {
    const host = mount({ multiline: true });
    const input = host.querySelector<HTMLTextAreaElement>(`textarea`)!;
    expect(input.classList.contains(`min-w-0`)).toBe(true);
    expect(input.classList.contains(`blur-mask`)).toBe(true);
    expect(input.getAttribute(`aria-label`)).toBe(`Paste the value for DEMO_KEY`);
    input.value = `first line\nsecond line`;
    input.dispatchEvent(new Event(`input`));
    await nextTick();
    host.querySelector<HTMLButtonElement>(`button[aria-label="Show value"]`)!.click();
    await nextTick();
    expect(input.classList.contains(`blur-mask`)).toBe(false);
    expect(input.value).toBe(`first line\nsecond line`);
    expect(draft.value).toBe(`first line\nsecond line`);
    expect(set).not.toHaveBeenCalled();
});

it(`lets collect mode submit its surrounding form without a standalone save or a secret write`, async () => {
    const host = mount({ collect: true });
    const input = host.querySelector<HTMLInputElement>(`input`)!;
    input.value = `collected-value`;
    input.dispatchEvent(new Event(`input`));
    await nextTick();
    const enter = new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    expect(draft.value).toBe(`collected-value`);
    expect([...host.querySelectorAll(`button`)].map((button) => button.getAttribute(`aria-label`))).toEqual([`Show value`]);
    expect(set).not.toHaveBeenCalled();
    expect(setCapability).not.toHaveBeenCalled();
});
