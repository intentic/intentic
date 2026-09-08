// @vitest-environment jsdom
// jsdom: pins that a whole-card-upsert edit doesn't silently drop untouched fields, and that a folder's persona
// list matches exactly, not more or fewer.
import type { Persona } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const personas = ref<Persona[]>([]);
const save = vi.fn<(persona: Persona) => Promise<unknown>>().mockResolvedValue({ ok: true });

vi.mock(`../../sandbox/personas/usePersonas`, () => ({
    usePersonas: () => ({
        personas,
        connected: ref([]),
        isConnected: () => false,
        error: ref(undefined),
        isLoading: ref(false),
        save: { mutateAsync: save, isPending: ref(false) },
        remove: { mutateAsync: vi.fn(), isPending: ref(false) },
    }),
}));

// Mocked since the real composable reaches the sandbox client at import time, unavailable under jsdom.
vi.mock(`../../capabilities/connect/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities: ref([]) }) }));

const { default: DirectoryPersonas } = await import("./DirectoryPersonas.vue");

let app: App | undefined;
// The dialog teleports to the body, so assertions target the document, not the mount point.
const mount = (dir: string | undefined): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup: () => {
            const model = ref(dir);
            return () => h(DirectoryPersonas, { modelValue: model.value, "onUpdate:modelValue": (next: string | undefined) => (model.value = next) });
        },
    });
    app.component(`Icon`, IconStub);
    app.component(
        `RouterLink`,
        defineComponent({
            props: { to: String },
            setup:
                (_props, { slots }) =>
                () =>
                    h(`a`, slots[`default`]?.()),
        }),
    );
    app.directive(`tooltip`, {});
    app.use(PrimeVue);
    app.mount(el);
};

const text = (): string => document.body.textContent ?? ``;
const buttonLabelled = (label: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));
const byAriaLabel = (label: string): HTMLElement | undefined => document.body.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? undefined;
const nameField = (): HTMLInputElement => byAriaLabel(`Name`) as HTMLInputElement;

const type = async (value: string): Promise<void> => {
    const field = nameField();
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

beforeEach(() => {
    save.mockClear();
    personas.value = [];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`saves a new persona that starts in the clicked folder`, async () => {
    mount(`intentic/_editor`);
    await nextTick();
    await type(`Refactor crew`);
    buttonLabelled(`Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
        id: `refactor-crew`,
        label: `Refactor crew`,
        capabilities: [],
        workspace: { startIn: `intentic/_editor` },
    });
});

it(`asks for a name and nothing else, and commits no powers`, async () => {
    mount(`docs`);
    await nextTick();
    expect(text()).toContain(`Advanced`);
    expect(text()).not.toContain(`Run commands`);
    await type(`Docs bot`);
    buttonLabelled(`Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].powers).toBeUndefined();
});

it(`reveals the permissions under Advanced`, async () => {
    mount(`docs`);
    await nextTick();
    buttonLabelled(`Advanced`)!.click();
    await nextTick();
    const shown = text();
    expect(shown).toContain(`Run commands`);
    expect(shown).toContain(`Change the sandbox`);
});

// A subfolder's card (`_editor/web`) doesn't count as starting in `_editor`, and a persona with no `startIn` doesn't
// either.
it(`lists every persona starting in this folder and no others`, async () => {
    personas.value = [
        { id: `docs-bot`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `refactor-crew`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `deep`, capabilities: [], workspace: { startIn: `intentic/_editor/web` } },
        { id: `elsewhere`, capabilities: [] },
    ];
    mount(`intentic/_editor`);
    await nextTick();
    expect(byAriaLabel(`Edit docs-bot`)).toEqual(expect.any(Object));
    expect(byAriaLabel(`Edit refactor-crew`)).toEqual(expect.any(Object));
    expect(byAriaLabel(`Edit deep`)).toBeUndefined();
    expect(byAriaLabel(`Edit elsewhere`)).toBeUndefined();
});

it(`keeps the rest of a card when it is renamed from the tree`, async () => {
    personas.value = [
        {
            id: `docs-bot`,
            label: `Docs bot`,
            capabilities: [`reddit-work`, `x-company`],
            brief: `Writes the docs.`,
            context: { repos: [`intentic`] },
            models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
            workspace: { startIn: `docs`, folders: [`docs`] },
        },
    ];
    mount(`docs`);
    await nextTick();
    byAriaLabel(`Edit Docs bot`)!.click();
    await nextTick();
    await type(`Docs crew`);
    buttonLabelled(`Save`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({
        id: `docs-bot`,
        label: `Docs crew`,
        capabilities: [`reddit-work`, `x-company`],
        brief: `Writes the docs.`,
        context: { repos: [`intentic`] },
        models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
        workspace: { startIn: `docs`, folders: [`docs`] },
    });
});

// Editing a bounded card opens Advanced automatically, so its powers show before the save that must preserve them.
it(`keeps the powers of a bounded card`, async () => {
    personas.value = [
        {
            id: `visitor`,
            capabilities: [],
            powers: { files: `read`, shell: false, code: false, web: true, browser: true, delegate: false, sandbox: false },
            workspace: { startIn: `docs` },
        },
    ];
    mount(`docs`);
    await nextTick();
    byAriaLabel(`Edit visitor`)!.click();
    await nextTick();
    expect(text()).toContain(`Run commands`);
    buttonLabelled(`Save`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].powers).toEqual({
        files: `read`,
        shell: false,
        code: false,
        web: true,
        browser: true,
        delegate: false,
        sandbox: false,
    });
});

it(`asks who works in the folder rather than announcing a list`, async () => {
    mount(`docs`);
    await nextTick();
    expect(text()).toContain(`Who works in docs`);
});

// The second route into this panel: point an existing card at this folder instead of creating a new one.
it(`points an existing persona at this folder, keeping everything else about it`, async () => {
    personas.value = [
        {
            id: `docs-bot`,
            label: `Docs bot`,
            capabilities: [`reddit-work`],
            brief: `Writes the docs.`,
            context: { repos: [`intentic`] },
            models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
            powers: { files: `read`, shell: false, code: false, web: true, browser: true, delegate: false, sandbox: true },
            workspace: { startIn: `docs`, folders: [`docs`] },
        },
    ];
    mount(`knowledge`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    byAriaLabel(`Start Docs bot here`)!.click();
    await nextTick();
    buttonLabelled(`Start here`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({
        id: `docs-bot`,
        label: `Docs bot`,
        capabilities: [`reddit-work`],
        brief: `Writes the docs.`,
        context: { repos: [`intentic`] },
        models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
        powers: { files: `read`, shell: false, code: false, web: true, browser: true, delegate: false, sandbox: true },
        workspace: { startIn: `knowledge`, folders: [`docs`] },
    });
});

it(`offers a persona that starts nowhere, and says so`, async () => {
    personas.value = [{ id: `free-agent`, capabilities: [] }];
    mount(`docs`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    expect(text()).toContain(`no starting folder`);
    byAriaLabel(`Start free-agent here`)!.click();
    await nextTick();
    expect(text()).not.toContain(`This moves it`);
    buttonLabelled(`Start here`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ id: `free-agent`, capabilities: [], workspace: { startIn: `docs` } });
});

it(`warns that pointing a card here takes it off the folder it starts in`, async () => {
    personas.value = [{ id: `docs-bot`, label: `Docs bot`, capabilities: [], workspace: { startIn: `docs` } }];
    mount(`knowledge`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    byAriaLabel(`Start Docs bot here`)!.click();
    await nextTick();
    const shown = text();
    expect(shown).toContain(`This moves it`);
    expect(shown).toContain(`docs`);
});

it(`does not offer a persona that already starts here`, async () => {
    personas.value = [
        { id: `docs-bot`, capabilities: [], workspace: { startIn: `docs` } },
        { id: `elsewhere`, capabilities: [], workspace: { startIn: `knowledge` } },
    ];
    mount(`docs`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    expect(byAriaLabel(`Start elsewhere here`)).toEqual(expect.any(Object));
    expect(byAriaLabel(`Start docs-bot here`)).toBeUndefined();
});

it(`does not offer to reuse a persona when there is none to reuse`, async () => {
    personas.value = [{ id: `docs-bot`, capabilities: [], workspace: { startIn: `docs` } }];
    mount(`docs`);
    await nextTick();
    expect(buttonLabelled(`Use one I already have`)).toBeUndefined();
});

it(`switches cleanly between naming a new persona and picking an existing one`, async () => {
    personas.value = [{ id: `docs-bot`, capabilities: [], workspace: { startIn: `knowledge` } }];
    mount(`docs`);
    await nextTick();
    await type(`Half typed`);
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    expect(nameField()).toBeUndefined();
    buttonLabelled(`Add a new one instead`)!.click();
    await nextTick();
    expect(nameField().value).toBe(``);
});

// A taken name would silently upsert that other persona instead, even one from a different folder.
it(`refuses a name another persona already has`, async () => {
    personas.value = [{ id: `docs-bot`, capabilities: [], workspace: { startIn: `elsewhere` } }];
    mount(`docs`);
    await nextTick();
    await type(`Docs bot`);
    expect(text()).toContain(`You already have a persona called docs-bot`);
    buttonLabelled(`Add persona`)!.click();
    await nextTick();
    expect(save).not.toHaveBeenCalled();
});
