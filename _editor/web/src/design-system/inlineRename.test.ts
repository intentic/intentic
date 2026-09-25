import "@intentic/testing/dom";
import { InlineRename } from "@intentic/ui";
import { waitFor } from "@intentic/testing/bun";
import { focusInput } from "@intentic/ui/inline-rename";
import { type App, createApp, h, nextTick, ref, vModelText, withDirectives } from "vue";

// The app's one rename control lives in @intentic/ui, which has no test runner; its contract is pinned here.
// What these assert is the thing the three call sites used to each answer differently: what the press opens, what
// commits, what a refusal does with the name you typed, and that no element joins or leaves the row when the mode
// changes — the whole reason the field and the text share one box.
// jsdom: the component swaps real DOM nodes; there is no layout here, so "nothing moves" is asserted as the shape
// that guarantees it (same children, an invisible twin per measurable string, a floating error).

let app: App | undefined;

// The component's own props, minus the one every case here shares: a literal `Record<string, unknown>` would let a
// renamed or dropped prop keep type-checking.
type RenameProps = InstanceType<typeof InlineRename>[`$props`];

const mount = (props: Omit<RenameProps, `label`> & { label?: string }): HTMLElement => {
    const host = document.createElement(`div`);
    document.body.append(host);
    app = createApp({ render: () => h(InlineRename, { ...props, label: props.label ?? `Sandbox name` }) });
    app.directive(`tooltip`, {});
    app.mount(host);
    return host;
};

const root = (host: HTMLElement): HTMLElement => host.firstElementChild as HTMLElement;
const name = (host: HTMLElement): HTMLButtonElement => host.querySelector<HTMLButtonElement>(`button`)!;
const field = (host: HTMLElement): HTMLInputElement => host.querySelector<HTMLInputElement>(`input`)!;
const twins = (host: HTMLElement): string[] => [...host.querySelectorAll(`span[aria-hidden="true"]`)].map((twin) => twin.textContent ?? ``);

const type = async (host: HTMLElement, text: string): Promise<void> => {
    const input = field(host);
    input.value = text;
    input.dispatchEvent(new Event(`input`));
    await nextTick();
};
const press = async (host: HTMLElement, key: string): Promise<void> => {
    field(host).dispatchEvent(new KeyboardEvent(`keydown`, { key, bubbles: true }));
    await nextTick();
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`reads as text until it is pressed, and says so to a screen reader`, () => {
    const host = mount({ value: `radarsu-intentic`, write: jest.fn(), action: `Rename sandbox` });
    expect(host.querySelector(`input`)).toBeNull();
    expect(name(host).textContent).toBe(`radarsu-intentic, Rename sandbox`);
    expect(name(host).querySelector(`.sr-only`)?.textContent).toBe(`, Rename sandbox`);
});

it(`opens a field carrying the name, selected, in the text's own place`, async () => {
    const host = mount({ value: `radarsu-intentic`, write: jest.fn() });
    name(host).click();
    await nextTick();

    const input = field(host);
    expect(input.value).toBe(`radarsu-intentic`);
    expect(input.getAttribute(`aria-label`)).toBe(`Sandbox name`);
    expect(document.activeElement).toBe(input);
    // Selected, not just focused, so the first keystroke replaces the name. A tick behind the mount: v-model
    // writes the value in its own mounted hook, and a selection made before that would be of the empty string.
    await waitFor(() => expect(input.selectionEnd).toBe(`radarsu-intentic`.length));
    expect(input.selectionStart).toBe(0);
});

// The measurement contract: one invisible twin per string the box has to be able to hold, in the same grid cell.
// With both present the cell is as wide as the longer, which is why the field starts the width of the name it
// replaced and grows with what is typed instead of jumping to a fixed width.
it(`sizes the box from the name at rest and from the draft while typing`, async () => {
    const host = mount({ value: `radarsu-intentic`, write: jest.fn() });
    expect(twins(host)).toEqual([`radarsu-intentic`]);

    name(host).click();
    await nextTick();
    expect(twins(host)).toEqual([`radarsu-intentic`, `radarsu-intentic`]);

    await type(host, `workbench for a very long name`);
    expect(twins(host)).toEqual([`radarsu-intentic`, `workbench for a very long name`]);
});

// Nothing appears beside the name when editing starts: the row holds the same two boxes in both modes, the
// affordance slot simply changes which glyph it carries.
it(`adds no control to the row when the mode changes`, async () => {
    const host = mount({ value: `radarsu-intentic`, write: jest.fn() });
    expect(root(host).children.length).toBe(2);
    expect(root(host).querySelectorAll(`button`).length).toBe(2);

    name(host).click();
    await nextTick();
    expect(root(host).children.length).toBe(2);
    expect(root(host).querySelectorAll(`button`).length).toBe(1);
    expect(root(host).querySelector(`button`)?.getAttribute(`aria-label`)).toBe(`Save`);
});

it(`commits the trimmed name on Enter and closes`, async () => {
    const write = jest.fn<(next: string) => Promise<void>>().mockResolvedValue(undefined);
    const host = mount({ value: `radarsu-intentic`, write });
    name(host).click();
    await nextTick();
    await type(host, `  workbench  `);
    await press(host, `Enter`);

    await waitFor(() => expect(write).toHaveBeenCalledWith(`workbench`));
    expect(write).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(host.querySelector(`input`)).toBeNull());
});

it(`commits on blur, so clicking away keeps what was typed`, async () => {
    const write = jest.fn<(next: string) => Promise<void>>().mockResolvedValue(undefined);
    const host = mount({ value: `radarsu-intentic`, write });
    name(host).click();
    await nextTick();
    await type(host, `workbench`);
    field(host).dispatchEvent(new FocusEvent(`blur`));

    await waitFor(() => expect(write).toHaveBeenCalledWith(`workbench`));
});

it(`writes nothing on Escape, and nothing for a name that did not change`, async () => {
    const write = jest.fn<(next: string) => Promise<void>>().mockResolvedValue(undefined);
    const host = mount({ value: `radarsu-intentic`, write });

    name(host).click();
    await nextTick();
    await type(host, `workbench`);
    await press(host, `Escape`);
    expect(write).toHaveBeenCalledTimes(0);
    expect(name(host).textContent).toBe(`radarsu-intentic, Rename`);

    name(host).click();
    await nextTick();
    await press(host, `Enter`);
    expect(write).toHaveBeenCalledTimes(0);
    expect(host.querySelector(`input`)).toBeNull();
});

it(`writes nothing for an emptied name, rather than saving a nameless thing`, async () => {
    const write = jest.fn<(next: string) => Promise<void>>().mockResolvedValue(undefined);
    const host = mount({ value: `radarsu-intentic`, write });
    name(host).click();
    await nextTick();
    await type(host, `   `);
    await press(host, `Enter`);

    expect(write).toHaveBeenCalledTimes(0);
    expect(host.querySelector(`input`)).toBeNull();
});

// The failure the three hand-rolled sites all got wrong: they closed the field and threw the typed name away.
it(`keeps the field open with the typed name when the write refuses, and floats the reason`, async () => {
    const write = jest.fn<(next: string) => Promise<void>>().mockRejectedValue(new Error(`The sandbox is offline.`));
    const host = mount({ value: `radarsu-intentic`, write, failure: `Couldn't save the sandbox's name.` });
    name(host).click();
    await nextTick();
    await type(host, `workbench`);
    await press(host, `Enter`);

    // Teleported to the document, fixed against the field's own window: this control is dropped into row groups
    // and cards that clip their overflow, and a refusal drawn inside one is cut off on the last row of a list.
    const alert = await waitFor(() => document.body.querySelector<HTMLElement>(`[role="alert"]`)!);
    expect(alert.parentElement).toBe(document.body);
    expect(alert.textContent).toBe(`The sandbox is offline.`);
    expect(alert.className).toContain(`fixed`);
    expect(field(host).value).toBe(`workbench`);
    expect(field(host).className).toContain(`ui-field-error-box`);
    expect(document.activeElement).toBe(field(host));
});

it(`says the app's own sentence when the refusal has no message of its own`, async () => {
    const write = jest.fn<(next: string) => Promise<void>>().mockRejectedValue(new Error(``));
    const host = mount({ value: `radarsu-intentic`, write, failure: `Couldn't save the sandbox's name.` });
    name(host).click();
    await nextTick();
    await type(host, `workbench`);
    await press(host, `Enter`);

    const alert = await waitFor(() => document.body.querySelector<HTMLElement>(`[role="alert"]`)!);
    expect(alert.textContent).toBe(`Couldn't save the sandbox's name.`);
});

it(`draws a nameless thing in its fallback words, and caps what can be typed`, async () => {
    const host = mount({ value: undefined, write: jest.fn(), fallback: `Sandbox`, maxlength: 60 });
    expect(name(host).textContent).toBe(`Sandbox, Rename`);

    name(host).click();
    await nextTick();
    expect(field(host).value).toBe(``);
    expect(field(host).getAttribute(`maxlength`)).toBe(`60`);
});

it(`is plain text where the name is not the reader's to change`, () => {
    const host = mount({ value: `radarsu-intentic`, write: jest.fn(), editable: false });
    expect(host.querySelector(`button`)).toBeNull();
    // The cell alone: no affordance slot to reserve when there is nothing to press.
    expect(root(host).children.length).toBe(1);
    // The cell holds its measuring twin and the name itself, in that order, in both modes.
    expect(root(host).children[0]?.lastElementChild?.textContent).toBe(`radarsu-intentic`);
});

// The field a surface draws itself (a tree row, a home tile, a terminal pill) binds its draft with v-model, whose own
// mounted hook writes the value AFTER `@vue:mounted` runs. A select() at mount selected the empty field, and F2 left the
// caret after the name instead of over it; the earlier test mounted a static `value` and so could not see it.
it(`selects the whole name in a v-model field that mounts already holding it`, async () => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const draft = ref(`main.ts`);
    app = createApp({
        render: () =>
            withDirectives(h(`input`, { "onUpdate:modelValue": (next: string) => (draft.value = next), onVnodeMounted: focusInput }), [
                [vModelText, draft.value],
            ]),
    });
    app.mount(host);
    await nextTick();

    const input = field(host);
    expect([document.activeElement === input, input.value, input.selectionStart, input.selectionEnd]).toEqual([true, `main.ts`, 0, 7]);
});
