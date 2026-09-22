// Pins what the page decides rather than displays: an open area writes as it changes, a folderless one is never sent
// (the daemon refuses it), a rename can't drop folders picked a moment ago, and the picker never offers a folder the
// schema would refuse. jsdom: renders and reads the mounted DOM.
import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { STATE_DIR, WORKSPACE_ROOT as root } from "@intentic/constants";
import type { Area } from "@intentic/sandbox-contract";
import { IconStub } from "@intentic/ui/testing";
import { it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import { type App, computed, createApp, h, nextTick, ref, ref as shallow } from "vue";
const areas = ref<Area[]>([]);
// Upserts like the real route: creating an area opens it immediately, so a mock that didn't add the row would leave
// the creation test asserting against a page that never redrew.
const save = mock<(area: Area) => Promise<unknown>>().mockImplementation(async (area) => {
    areas.value = [...areas.value.filter((entry) => entry.id !== area.id), area];
    return { ok: true };
});
const remove = mock<(id: string) => Promise<unknown>>().mockResolvedValue({ ok: true });

mock.module(`./useAreas`, () => ({
    useAreas: () => ({
        areas,
        labelOf: (id: string) => id,
        error: ref(undefined),
        isLoading: ref(false),
        save: { mutateAsync: save, isPending: ref(false) },
        remove: { mutateAsync: remove, isPending: ref(false) },
    }),
}));

// The cards the rows report: an area hands over the assistants homed inside its folders, which the page derives
// rather than stores, so the suite needs the roster the derivation reads.
const personas = ref([
    { id: `support-bot`, label: `Support bot`, capabilities: [], workspace: { startIn: `web/support` } },
    { id: `scribe`, label: `Scribe`, capabilities: [], workspace: { startIn: `docs` } },
]);
mock.module(`../personas/usePersonas`, () => ({ usePersonas: () => ({ personas, connected: ref([]), isConnected: () => false }) }));

const role = ref<string>(`owner`);
mock.module(`../client/useSandbox`, () => ({ useSandbox: () => ({ active: ref({ role: role.value }) }) }));
mock.module(`../overview/useSandboxOutline`, () => ({ useSandboxOutline: () => ref(true) }));

// <FolderPicker>'s own reads; this suite is about the page, so the tree is a fixture and nothing is fetched lazily.
const tree = ref<WorkspaceTreeEntry[]>([]);
mock.module(`../client/sandboxClient`, () => ({ sandboxJson: mock().mockResolvedValue({ entries: [] }) }));
mock.module(`../client/useSandboxQuery`, () => {
    // Imported inside the factory so the mock owns its own bindings, not this file's.
    return {
        useSandboxQuery: () => ({
            query: { data: computed(() => ({ root, tree: tree.value, hidden: 0 })), isPending: shallow(false) },
            error: shallow(undefined),
        }),
    };
});

const { default: SandboxAreas } = await import("./SandboxAreas.vue");

let app: App | undefined;
// Icon is registered app-wide in the real app; a stand-in keeps this off the whole UI plugin.
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxAreas) });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

// The facts a row states about itself, in the pills it states them in — the picker's chips are `ui-chip`, not these.
const badges = (el: HTMLElement): string[] => [...el.querySelectorAll(`.ui-status-pill`)].map((pill) => (pill.textContent ?? ``).trim());

const buttonLabelled = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));

// A row's name IS its rename control (<InlineRename>): the button reads as the name with the verb behind it for a
// screen reader, so that whole string is what identifies the row.
const nameControl = (el: HTMLElement, name: string): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent === `${name}, Rename area`)!;

const openRow = async (el: HTMLElement, name: string): Promise<void> => {
    nameControl(el, name)
        .closest(`.group`)!
        .dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    await nextTick();
};

// The picker teleports its panel into the document body, so its rows are searched from there.
const folderRow = (name: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).trim() === name);

// Its opener is the field group's last button: the chips for what is already picked come first.
const openFolderPicker = async (el: HTMLElement): Promise<void> => {
    const group = [...el.querySelectorAll<HTMLElement>(`[role="group"][aria-label="Folders"]`)].at(-1)!;
    [...group.querySelectorAll(`button`)].at(-1)!.click();
    await nextTick();
};

const pickFolder = async (el: HTMLElement, path: string): Promise<void> => {
    await openFolderPicker(el);
    folderRow(path)!.click();
    await nextTick();
};

const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

beforeEach(() => {
    jest.useRealTimers();
    save.mockClear();
    remove.mockClear();
    role.value = `owner`;
    areas.value = [{ id: `support`, label: `Support desk`, folders: [`web/support`] }];
    tree.value = [
        { name: `web`, path: `web`, type: `dir`, children: [{ name: `support`, path: `web/support`, type: `dir`, children: [] }] },
        { name: `docs`, path: `docs`, type: `dir`, children: [] },
        // The control plane: no area may name it, so the picker must not offer it.
        { name: STATE_DIR, path: STATE_DIR, type: `dir`, children: [] },
        // Ignored, like node_modules anywhere else.
        { name: `node_modules`, path: `node_modules`, type: `dir`, ignored: true },
    ];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`writes an open area as it changes, with no Save button anywhere`, async () => {
    const el = mount();
    await openRow(el, `Support desk`);
    expect(buttonLabelled(el, `Save`)).toBeUndefined();

    await pickFolder(el, `docs`);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0].folders).toEqual([`web/support`, `docs`]);
});

it(`holds the write while an area holds no folder, and says what it is waiting for`, async () => {
    const el = mount();
    await openRow(el, `Support desk`);

    el.querySelector<HTMLButtonElement>(`button[aria-label="Remove web/support"]`)!.click();
    await nextTick();
    await new Promise((resolve) => setTimeout(resolve, 600));

    // A grant with no reader is what the daemon refuses; the page says so instead of sending one.
    expect(save).not.toHaveBeenCalled();
    expect(el.textContent).toContain(`Pick at least one folder`);

    // Closing drops the half-made draft: what the row reads is what is stored.
    await openRow(el, `Support desk`);
    expect(el.textContent).toContain(`web/support`);
});

it(`keeps a folder picked a moment ago when the name is committed`, async () => {
    const el = mount();
    await openRow(el, `Support desk`);
    await pickFolder(el, `docs`);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

    nameControl(el, `Support desk`).click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input[aria-label="Area name"]`)!;
    await type(field, `Help centre`);
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1]![0]).toMatchObject({ id: `support`, label: `Help centre`, folders: [`web/support`, `docs`] });
});

it(`refuses to create an area until it has both a name and a folder, then opens it`, async () => {
    const el = mount();
    buttonLabelled(el, `New area`)!.click();
    await nextTick();

    const create = (): HTMLButtonElement => buttonLabelled(el, `Create`)!;
    expect(create().disabled).toBe(true);

    await type(el.querySelector<HTMLInputElement>(`input[aria-label="Area name"]`)!, `Marketing site`);
    expect(create().disabled).toBe(true);
    expect(el.textContent).toContain(`Pick at least one folder`);

    await pickFolder(el, `docs`);
    expect(create().disabled).toBe(false);

    create().click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ id: `marketing-site`, label: `Marketing site`, folders: [`docs`] });

    // Named it, now say what it is: the new row is the open one.
    await waitFor(() => expect(el.querySelector(`input[id="area-brief-marketing-site"]`)).not.toBeNull());
});

it(`never offers the sandbox's own configuration as a folder`, async () => {
    const el = mount();
    await openRow(el, `Support desk`);
    await openFolderPicker(el);

    expect(folderRow(`docs`)).not.toBeUndefined();
    expect(folderRow(`.intentic`)).toBeUndefined();
    expect(folderRow(`node_modules`)).toBeUndefined();
});

it(`names the assistants an area hands over, and keeps naming them while the row is open`, async () => {
    const el = mount();

    // Homed at `web/support`, which this area covers; the other card lives in `docs`, which it does not.
    expect(badges(el)).toContain(`Support bot`);
    expect(badges(el)).not.toContain(`Scribe`);
    expect(badges(el)).toContain(`web/support`);

    await openRow(el, `Support desk`);
    // The folders are the drawer's to edit, so their badge steps aside; who the area hands over is edited nowhere.
    expect(badges(el)).not.toContain(`web/support`);
    expect(badges(el)).toContain(`Support bot`);
});

it(`shows a member the areas and none of the controls`, async () => {
    role.value = `collaborator`;
    const el = mount();

    expect(el.textContent).toContain(`Support desk`);
    expect(el.textContent).toContain(`Only the sandbox owner decides who sees which folders.`);
    expect(buttonLabelled(el, `New area`)).toBeUndefined();
    expect(el.querySelector(`[aria-label="Delete area"]`)).toBeNull();
    // Nothing to open: a member cannot edit what is behind the name.
    expect(el.querySelector(`[aria-expanded]`)).toBeNull();
});
