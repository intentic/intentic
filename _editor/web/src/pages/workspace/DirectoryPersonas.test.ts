// @vitest-environment jsdom
//
// jsdom because the two things that can go wrong here are things the surface DOES, and both are silent. The panel
// writes cards through a whole-card upsert, so an edit that forgets a field it never showed does not fail — it
// quietly strips the accounts off somebody's persona. And a folder holds several cards, so a panel that listed the
// wrong ones would send an edit to a persona belonging somewhere else.
import type { Persona } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

vi.hoisted(() => {
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
});

const personas = ref<Persona[]>([]);
const save = vi.fn<(persona: Persona) => Promise<unknown>>().mockResolvedValue({ ok: true });

vi.mock(`../../composables/sandbox/usePersonas`, () => ({
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

// Mocked rather than left real because the composable behind it reaches the sandbox client at import time, which
// has no environment under jsdom.
vi.mock(`../../composables/extensions/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities: ref([]) }) }));

const { default: DirectoryPersonas } = await import("./DirectoryPersonas.vue");

let app: App | undefined;
// The dialog teleports to the body, so everything is asserted against the document rather than the mount point.
const mount = (dir: string | undefined): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup: () => {
            const model = ref(dir);
            return () => h(DirectoryPersonas, { modelValue: model.value, "onUpdate:modelValue": (next: string | undefined) => (model.value = next) });
        },
    });
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
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

// THE WHOLE POINT: the folder comes from the row, not from a field somebody retypes.
it(`saves a new persona that starts in the clicked folder`, async () => {
    mount(`intentic/_editor`);
    await nextTick();
    await type(`Refactor crew`);
    buttonLabelled(`Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toMatchObject({
        id: `refactor-crew`,
        label: `Refactor crew`,
        capabilities: [],
        workspace: { startIn: `intentic/_editor` },
    });
});

// Permissions are behind Advanced, so an untouched panel must commit no powers block at all — otherwise every
// card added from the tree writes ten fields meaning "yes" into a tracked file.
it(`asks for a name and nothing else, and commits no powers`, async () => {
    mount(`docs`);
    await nextTick();
    expect(text()).toContain(`Advanced`);
    expect(text()).not.toContain(`Run commands`);
    await type(`Docs bot`);
    buttonLabelled(`Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
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

/* A FOLDER HOLDS SEVERAL. Both cards that start here are listed, and neither the card of a subfolder nor one that
 * merely prefers the repo is — an edit sent to the wrong card is invisible until something stops posting. */
it(`lists every persona starting in this folder and no others`, async () => {
    personas.value = [
        { id: `docs-bot`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `refactor-crew`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `deep`, capabilities: [], workspace: { startIn: `intentic/_editor/web` } },
        { id: `elsewhere`, capabilities: [] },
    ];
    mount(`intentic/_editor`);
    await nextTick();
    expect(byAriaLabel(`Edit docs-bot`)).toBeDefined();
    expect(byAriaLabel(`Edit refactor-crew`)).toBeDefined();
    expect(byAriaLabel(`Edit deep`)).toBeUndefined();
    expect(byAriaLabel(`Edit elsewhere`)).toBeUndefined();
});

/* THE SAVE IS AN UPSERT OF THE WHOLE CARD. Editing a name from the tree must carry over everything this panel
 * never shows — the accounts it speaks through, the projects that prefer it, the folders it is fenced to —
 * because a field left out of the payload is a field taken off the card. */
it(`keeps the rest of a card when it is renamed from the tree`, async () => {
    personas.value = [
        {
            id: `docs-bot`,
            label: `Docs bot`,
            capabilities: [`reddit-work`, `x-company`],
            repos: [`intentic`],
            workspace: { startIn: `docs`, folders: [`docs`] },
        },
    ];
    mount(`docs`);
    await nextTick();
    byAriaLabel(`Edit Docs bot`)!.click();
    await nextTick();
    await type(`Docs crew`);
    buttonLabelled(`Save`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toEqual({
        // The id is frozen: automations pin to it, so a rename changes the label only.
        id: `docs-bot`,
        label: `Docs crew`,
        capabilities: [`reddit-work`, `x-company`],
        repos: [`intentic`],
        workspace: { startIn: `docs`, folders: [`docs`] },
    });
});

// A bounded card opens with its bounds on screen rather than folded away, and they survive a save from here.
it(`keeps the powers of a bounded card`, async () => {
    personas.value = [
        {
            id: `visitor`,
            capabilities: [],
            powers: { files: `read`, shell: false, web: true, browser: true, delegate: false, sandbox: false },
            workspace: { startIn: `docs` },
        },
    ];
    mount(`docs`);
    await nextTick();
    byAriaLabel(`Edit visitor`)!.click();
    await nextTick();
    expect(text()).toContain(`Run commands`);
    buttonLabelled(`Save`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].powers).toEqual({
        files: `read`,
        shell: false,
        web: true,
        browser: true,
        delegate: false,
        sandbox: false,
    });
});

/* A new card landing on a name already taken would upsert that card instead — including one belonging to a
 * different folder, which is the case this panel makes easy to hit. */
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
