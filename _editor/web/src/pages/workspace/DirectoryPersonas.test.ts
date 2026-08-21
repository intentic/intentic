// @vitest-environment jsdom
//
// jsdom because the two things that can go wrong here are things the surface DOES, and both are silent. The panel
// writes cards through a whole-card upsert, so an edit that forgets a field it never showed does not fail: it
// quietly strips the accounts off somebody's persona. And a folder holds several cards, so a panel that listed the
// wrong ones would send an edit to a persona belonging somewhere else.
import type { Persona } from "@intentic/sandbox-contract";
import PrimeVue from "primevue/config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";

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

// Permissions are behind Advanced, so an untouched panel must commit no powers block at all: otherwise every
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
 * merely prefers the repo is: an edit sent to the wrong card is invisible until something stops posting. */
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
 * never shows: the accounts it speaks through, the projects that prefer it, the folders it is fenced to:
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
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
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

/* THE HEADER IS THE FOLDER'S QUESTION. "Personas in docs" claimed a list on a folder that has none, which is
 * every folder somebody opens this from the first time, and read as cards stored in that folder besides. */
it(`asks who works in the folder rather than announcing a list`, async () => {
    mount(`docs`);
    await nextTick();
    expect(text()).toContain(`Who works in docs`);
});

/* ── Pointing a card you already have at this folder ───────────────────────────────────────────────────────
 *
 * The second reason anyone opens this panel: "Docs bot" exists, and it should work HERE. Before this the only
 * route was the Personas page plus retyping the path, and the likelier outcome was a second card named
 * "Docs bot 2" doing the same job. */
it(`points an existing persona at this folder, keeping everything else about it`, async () => {
    personas.value = [
        {
            id: `docs-bot`,
            label: `Docs bot`,
            capabilities: [`reddit-work`],
            repos: [`intentic`],
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
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toEqual({
        id: `docs-bot`,
        label: `Docs bot`,
        capabilities: [`reddit-work`],
        repos: [`intentic`],
        powers: { files: `read`, shell: false, code: false, web: true, browser: true, delegate: false, sandbox: true },
        // The one field the mode is about. The fence it was given stays the fence it was given.
        workspace: { startIn: `knowledge`, folders: [`docs`] },
    });
});

// A card with no starting folder at all is the likeliest thing to point at one, so it has to be offered.
it(`offers a persona that starts nowhere, and says so`, async () => {
    personas.value = [{ id: `free-agent`, capabilities: [] }];
    mount(`docs`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    expect(text()).toContain(`no starting folder`);
    byAriaLabel(`Start free-agent here`)!.click();
    await nextTick();
    // Nothing is being taken away, so there is no move to warn about.
    expect(text()).not.toContain(`This moves it`);
    buttonLabelled(`Start here`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toEqual({ id: `free-agent`, capabilities: [], workspace: { startIn: `docs` } });
});

/* A PERSONA HAS ONE STARTING FOLDER, so this MOVES it, and the folder losing it is not on this screen, which
 * is the only place the change would otherwise be noticed. */
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

/* The cards already starting here are the list at the top of the panel. Offering them again would be an action
 * that changes nothing, and there is nothing to point at a folder it already starts in. */
it(`does not offer a persona that already starts here`, async () => {
    personas.value = [
        { id: `docs-bot`, capabilities: [], workspace: { startIn: `docs` } },
        { id: `elsewhere`, capabilities: [], workspace: { startIn: `knowledge` } },
    ];
    mount(`docs`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    expect(byAriaLabel(`Start elsewhere here`)).toBeDefined();
    expect(byAriaLabel(`Start docs-bot here`)).toBeUndefined();
});

// With no other card in the sandbox there is nothing to borrow, so the offer is absent rather than opening an
// empty picker.
it(`does not offer to reuse a persona when there is none to reuse`, async () => {
    personas.value = [{ id: `docs-bot`, capabilities: [], workspace: { startIn: `docs` } }];
    mount(`docs`);
    await nextTick();
    expect(buttonLabelled(`Use one I already have`)).toBeUndefined();
});

// The name and the picked card are answers to different questions, and only one of them is being asked.
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

/* A new card landing on a name already taken would upsert that card instead: including one belonging to a
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
