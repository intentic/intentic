// jsdom: pins that a whole-card-upsert edit doesn't silently drop untouched fields, that a card already starting here is
// renamed in its own row with no edit mode to enter, its bounds read off the access profiles holding it, and that a
// folder's role list matches exactly, not more or fewer.
import "@intentic/testing/dom";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Role } from "@intentic/sandbox-contract/schemas/roles";
import PrimeVue from "primevue/config";
import { waitFor } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

const roles = ref<Role[]>([]);
const save = jest.fn<(role: Role) => Promise<unknown>>().mockResolvedValue({ ok: true });

jest.mock(`../../../models/sandbox/roles/useRoles`, () => ({
    useRoles: () => ({
        roles,
        connected: ref([]),
        isConnected: () => false,
        error: ref(undefined),
        isLoading: ref(false),
        save: { mutateAsync: save, isPending: ref(false) },
        remove: { mutateAsync: jest.fn(), isPending: ref(false) },
    }),
}));

// What each card may reach: the access profiles listing it.
const profiles = ref<AccessProfile[]>([]);
jest.mock(`../../../models/sandbox/access/useAccessProfiles`, () => ({ useAccessProfiles: () => ({ profiles }) }));

const { default: DirectoryRoles } = await import("./DirectoryRoles.vue");

let app: App | undefined;
// The dialog teleports to the body, so assertions target the document, not the mount point.
const mount = (dir: string | undefined): void => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup: () => {
            const model = ref(dir);
            return () => h(DirectoryRoles, { modelValue: model.value, "onUpdate:modelValue": (next: string | undefined) => (model.value = next) });
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
// A card's name at rest: InlineRename's press target, which says the name and then the verb.
const renameOf = (name: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).trim().startsWith(`${name}, `));

const type = async (value: string): Promise<void> => {
    const field = nameField();
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

beforeEach(() => {
    save.mockClear();
    roles.value = [];
    profiles.value = [];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`saves a new role that starts in the clicked folder`, async () => {
    mount(`intentic/_editor`);
    await nextTick();
    await type(`Refactor crew`);
    buttonLabelled(`Add role`)!.click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({
        id: `refactor-crew`,
        label: `Refactor crew`,
        capabilities: [],
        workspace: { startIn: `intentic/_editor` },
    });
});

// What a card may reach is access, set on Access ▸ Profiles: the panel asks for a name and a line, never a permission.
it(`asks for a name and what it is for, and no permission`, async () => {
    mount(`docs`);
    await nextTick();
    expect(text()).not.toContain(`Run commands`);
    await type(`Docs bot`);
    const brief = byAriaLabel(`What it's for`) as HTMLInputElement;
    brief.value = `Keeps the docs current`;
    brief.dispatchEvent(new Event(`input`));
    await nextTick();
    buttonLabelled(`Add role`)!.click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({
        id: `docs-bot`,
        label: `Docs bot`,
        brief: `Keeps the docs current`,
        capabilities: [],
        workspace: { startIn: `docs` },
    });
});

// A subfolder's card (`_editor/web`) doesn't count as starting in `_editor`, and a role with no `startIn` doesn't
// either.
it(`lists every role starting in this folder and no others`, async () => {
    roles.value = [
        { id: `docs-bot`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `refactor-crew`, capabilities: [], workspace: { startIn: `intentic/_editor` } },
        { id: `deep`, capabilities: [], workspace: { startIn: `intentic/_editor/web` } },
        { id: `elsewhere`, capabilities: [] },
    ];
    mount(`intentic/_editor`);
    await nextTick();
    expect(renameOf(`docs-bot`)).toEqual(expect.any(Object));
    expect(renameOf(`refactor-crew`)).toEqual(expect.any(Object));
    expect(renameOf(`deep`)).toBeUndefined();
    expect(renameOf(`elsewhere`)).toBeUndefined();
});

it(`keeps the rest of a card when it is renamed from the tree`, async () => {
    roles.value = [
        {
            id: `docs-bot`,
            label: `Docs bot`,
            capabilities: [`reddit-work`, `x-company`],
            brief: `Writes the docs.`,
            context: { repos: [`intentic`] },
            models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
            workspace: { startIn: `docs` },
        },
    ];
    mount(`docs`);
    await nextTick();
    expect(buttonLabelled(`Edit`)).toBeUndefined();
    renameOf(`Docs bot`)!.click();
    await nextTick();
    // The name's own field, in the row, before the new card's field further down.
    const field = document.body.querySelectorAll<HTMLInputElement>(`[aria-label="Name"]`)[0]!;
    field.value = `Docs crew`;
    field.dispatchEvent(new Event(`input`));
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({
        id: `docs-bot`,
        label: `Docs crew`,
        capabilities: [`reddit-work`, `x-company`],
        brief: `Writes the docs.`,
        context: { repos: [`intentic`] },
        models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
        workspace: { startIn: `docs` },
    });
});

// A card's bounds are the access profiles listing it: badged beside its row, and nothing to press.
it(`badges a card by the profile that holds it`, async () => {
    roles.value = [
        { id: `visitor`, capabilities: [], workspace: { startIn: `docs` } },
        { id: `writer`, capabilities: [], workspace: { startIn: `docs` } },
    ];
    profiles.value = [{ id: `public`, tools: { files: `read`, shell: false }, roles: [`visitor`] }];
    mount(`docs`);
    await nextTick();
    expect(text()).toContain(`Read-only`);
    expect(text()).not.toContain(`Full powers`);
    expect(document.body.querySelector(`button[aria-expanded]`)).toBeNull();
});

it(`asks who works in the folder rather than announcing a list`, async () => {
    mount(`docs`);
    await nextTick();
    expect(text()).toContain(`Who works in docs`);
});

// The second route into this panel: point an existing card at this folder instead of creating a new one.
it(`points an existing role at this folder, keeping everything else about it`, async () => {
    roles.value = [
        {
            id: `docs-bot`,
            label: `Docs bot`,
            capabilities: [`reddit-work`],
            brief: `Writes the docs.`,
            context: { repos: [`intentic`] },
            models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
            workspace: { startIn: `docs` },
        },
    ];
    mount(`knowledge`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    byAriaLabel(`Start Docs bot here`)!.click();
    await nextTick();
    buttonLabelled(`Start here`)!.click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({
        id: `docs-bot`,
        label: `Docs bot`,
        capabilities: [`reddit-work`],
        brief: `Writes the docs.`,
        context: { repos: [`intentic`] },
        models: [{ provider: `claude`, model: `claude-haiku-4-5` }],
        workspace: { startIn: `knowledge` },
    });
});

it(`offers a role that starts nowhere, and says so`, async () => {
    roles.value = [{ id: `free-agent`, capabilities: [] }];
    mount(`docs`);
    await nextTick();
    buttonLabelled(`Use one I already have`)!.click();
    await nextTick();
    expect(text()).toContain(`no starting folder`);
    byAriaLabel(`Start free-agent here`)!.click();
    await nextTick();
    expect(text()).not.toContain(`This moves it`);
    buttonLabelled(`Start here`)!.click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ id: `free-agent`, capabilities: [], workspace: { startIn: `docs` } });
});

it(`warns that pointing a card here takes it off the folder it starts in`, async () => {
    roles.value = [{ id: `docs-bot`, label: `Docs bot`, capabilities: [], workspace: { startIn: `docs` } }];
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

it(`does not offer a role that already starts here`, async () => {
    roles.value = [
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

it(`does not offer to reuse a role when there is none to reuse`, async () => {
    roles.value = [{ id: `docs-bot`, capabilities: [], workspace: { startIn: `docs` } }];
    mount(`docs`);
    await nextTick();
    expect(buttonLabelled(`Use one I already have`)).toBeUndefined();
});

it(`switches cleanly between naming a new role and picking an existing one`, async () => {
    roles.value = [{ id: `docs-bot`, capabilities: [], workspace: { startIn: `knowledge` } }];
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

// A taken name would silently upsert that other role instead, even one from a different folder.
it(`refuses a name another role already has`, async () => {
    roles.value = [{ id: `docs-bot`, capabilities: [], workspace: { startIn: `elsewhere` } }];
    mount(`docs`);
    await nextTick();
    await type(`Docs bot`);
    expect(text()).toContain(`You already have a role called docs-bot`);
    buttonLabelled(`Add role`)!.click();
    await nextTick();
    expect(save).not.toHaveBeenCalled();
});
