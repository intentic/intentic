// Pins two wordings that cost something if wrong: marking a role whose accounts are all signed out, and saving both
// accounts on a role that spans sites. jsdom: renders and reads the mounted DOM.
import { WORKSPACE_ROOT } from "@intentic/constants";
import "@intentic/testing/dom";
import type { AccessProfile, AccessProfileEntry } from "@intentic/sandbox-contract/schemas/access-profiles";
import { type Role, TURN_BRIEFING_FIXTURES, TURN_BRIEFING_NOTES } from "@intentic/sandbox-contract/schemas/roles";
import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import type { BrowserAccount } from "../../extensions/useBrowserAccounts";
import { waitFor } from "@intentic/testing/bun";
import { type App, computed, createApp, h, nextTick, ref, ref as shallow } from "vue";
import { IconStub } from "@intentic/ui/testing";
import PrimeVue from "primevue/config";
import { createMemoryHistory, createRouter, type Router } from "vue-router";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

(() => {
    // jsdom has no ResizeObserver; AnchoredOverlay throws on open without one, as an unhandled rejection off the
    // assertion path.
})();

const roles = ref<Role[]>([]);
const connected = ref<string[]>([]);
const isLoading = ref(false);
// Upserts like the real route; creating a role opens it immediately, so a mock that didn't add the role would leave
// creation tests asserting against a page that never redrew.
const save = jest.fn<(role: Role) => Promise<unknown>>().mockImplementation(async (role) => {
    roles.value = [...roles.value.filter((entry) => entry.id !== role.id), role];
    return { ok: true };
});
const remove = jest.fn<(id: string) => Promise<unknown>>().mockResolvedValue({ ok: true });

jest.mock(`../../../models/sandbox/roles/useRoles`, () => ({
    useRoles: () => ({
        roles,
        connected,
        isConnected: (id: string) => connected.value.includes(id),
        loaded: computed(() =>
            isLoading.value ? { state: `waiting`, since: 0, retry: undefined } : { state: `ready`, data: roles.value, refreshing: false, refreshError: undefined },
        ),
        save: { mutateAsync: save, isPending: ref(false) },
        remove: { mutateAsync: remove, isPending: ref(false) },
    }),
}));

const accounts = ref<BrowserAccount[]>([]);
jest.mock(`../../extensions/useBrowserAccounts`, () => ({
    useBrowserAccounts: () => ({ accounts, accountOf: (id: string) => accounts.value.find((entry) => entry.id === id) }),
}));


// Stubbed separately from the query mock below, which answers everything with a workspace tree; this suite is about the
// role, so the kit answers empty.
jest.mock(`./useRoleKit`, () => {
    const idle = { mutateAsync: jest.fn().mockResolvedValue({ ok: true }), isPending: shallow(false) };
    return {
        useRoleKit: () => ({
            kit: computed(() => ({ prompt: ``, skills: [] })),
            readSkill: jest.fn(),
            error: shallow(undefined),
            isLoading: shallow(false),
            savePrompt: idle,
            saveSkill: idle,
            removeSkill: idle,
        }),
    };
});

// A real small tree, not empty, since "the picker lists your folders" is the actual claim under test; the file is here
// to be filtered out.
const tree = ref<WorkspaceTreeEntry[]>([]);
const nestedRepos = ref<string[]>([]);
// <FolderPicker>'s lazy listing, the one daemon call the page itself makes.
jest.mock(`../../../client/sandbox/sandboxRpc`, () => ({
    sandboxRpc: fakeSandboxRpc({ workspace: { children: jest.fn(async () => ({ entries: [], hidden: 0 })) } }),
}));
// Every name the graph imports from the raw client, since bun links an ESM import against exactly what this factory
// returns; nothing here calls it.
jest.mock(`../../../client/sandbox/sandboxClient`, () => ({
    sandboxJson: jest.fn(),
    sandboxRequest: jest.fn(),
    sandboxError: jest.fn(async () => new Error(`unused`)),
}));
// The named parts of the workspace: the role editor reads them to say which of them gain the role being written.
// Holds the `docs` folder of the tree below, so a role starting there is one this area hands over.
const areas = ref([{ id: `handbook`, label: `Handbook`, folders: [`docs`] }]);
jest.mock(`../../../models/sandbox/access/useAreas`, () => ({ useAreas: () => ({ areas }) }));
jest.mock(`../../../client/sandbox/useSandboxQuery`, () => {
    const answer = computed(() => ({ root: WORKSPACE_ROOT, tree: tree.value, hidden: 0, repos: nestedRepos.value }));
    return {
        useSandboxQuery: () => ({
            query: { data: answer, isPending: shallow(false) },
            error: shallow(undefined),
            loaded: computed(() => ({ state: `ready`, data: answer.value, refreshing: false, refreshError: undefined })),
        }),
    };
});

// The access profiles, for the Access tab: which hold the open role, and the writes that move it between them.
const profiles = ref<AccessProfileEntry[]>([]);
const saveProfile = jest.fn<(profile: AccessProfile) => Promise<unknown>>().mockImplementation(async (profile) => {
    profiles.value = profiles.value.map((entry) => (entry.id === profile.id ? { ...profile, origin: entry.origin } : entry));
    return { ok: true, holders: [] };
});
jest.mock(`../../../models/sandbox/access/useAccessProfiles`, () => ({
    useAccessProfiles: () => ({ available: computed(() => true), profiles, save: { mutateAsync: saveProfile, isPending: ref(false) } }),
}));
const peopleRight = ref(true);
jest.mock(`../../../client/sandbox/access/useAccess`, () => ({ useAccess: () => ({ holds: () => peopleRight.value }) }));

const { default: SandboxRoles } = await import("./SandboxRoles.vue");

// No logo, so <BrandMark> falls back to its glyph tier, the same as a site the manifest has no mark for.
const account = (id: string, platform: string): BrowserAccount => ({ id, platform, site: platform, logo: undefined, icon: `globe` });

let app: App | undefined;
let router: Router;
// Icon is registered app-wide in the real app; a stand-in keeps this off the whole UI plugin.
const mount = (props: { open?: string } = {}): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxRoles, props) });
    app.use(PrimeVue);
    // Carries the icon name through as an attribute, so a test can assert which glyph a row wears, not just that it
    // wears one.
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    // The open role is written to the address, so the page needs a router to write it to.
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/`, component: { render: () => null } }] });
    app.use(router);
    app.mount(el);
    return el;
};

const text = (el: HTMLElement): string => el.textContent ?? ``;
const buttonLabelled = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));
const nameField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[aria-label="Name this role"]`)!;
const byAriaLabel = (el: HTMLElement, label: string): HTMLElement | undefined =>
    el.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? undefined;
// Rename rides the open role's heading (<InlineRename>): the name itself is the press target, and says the verb.
const nameControl = (el: HTMLElement, name: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll<HTMLButtonElement>(`h3 button`)].find((button) => (button.textContent ?? ``).trim() === `${name}, Rename role`);

const tileFor = (el: HTMLElement, id: string): HTMLButtonElement => {
    const role = roles.value.find((entry) => entry.id === id)!;
    return [...el.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="Your roles"] button[aria-pressed]`)].find(
        (button) => button.getAttribute(`aria-label`) === (role.label ?? role.id),
    )!;
};
const removeControl = (el: HTMLElement, id: string): HTMLButtonElement =>
    tileFor(el, id).parentElement!.querySelector<HTMLButtonElement>(`button[aria-label="Remove this role"]`)!;
// A built-in's row carries no remove control: it is always there.
const removeControlFor = (el: HTMLElement, label: string): HTMLElement | undefined =>
    [...el.querySelectorAll<HTMLElement>(`button[aria-label="Remove this role"]`)].find((button) => (button.closest(`li, [role="listitem"], div`)?.textContent ?? ``).includes(label));
const openRole = async (el: HTMLElement, id: string): Promise<void> => {
    const tile = tileFor(el, id);
    if (tile.getAttribute(`aria-pressed`) !== `true`) {
        tile.click();
    }
    await waitFor(() => expect(el.querySelector(`[role="tab"]`)).not.toBeNull());
};

// PrimeVue's ToggleSwitch is a checkbox under its skin; flips it by the label text beside it.
const toggleSwitch = (el: HTMLElement, label: string): void => {
    const row = [...el.querySelectorAll(`label`)].find((entry) => (entry.textContent ?? ``).includes(label))!;
    row.querySelector<HTMLInputElement>(`input[type="checkbox"]`)!.click();
};

// Searched from `document`, not the mounted element, since the picker's <AnchoredOverlay> teleports into the document
// body.
const folderRow = (name: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).trim() === name);

// Its opener is the group's last button (the chips for what's already picked come first), reached by the field's own
// group rather than counting `Choose` buttons.
const openFolderPicker = async (el: HTMLElement, field: string): Promise<void> => {
    const group = el.querySelector<HTMLElement>(`[role="group"][aria-label="${field}"]`)!;
    [...group.querySelectorAll(`button`)].at(-1)!.click();
    await nextTick();
};

// Sets the value and dispatches the input event a v-model listens for.
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

// The chooser is folded away until opened; every test that picks an account opens it first.
const chooseAccounts = async (el: HTMLElement): Promise<void> => {
    buttonLabelled(el, `Choose accounts`)?.click();
    await nextTick();
};

// Used by every test that needs an open role: name, then Create, then wait for the save.
const addRole = async (el: HTMLElement, name: string): Promise<void> => {
    buttonLabelled(el, `Add a role`)!.click();
    await nextTick();
    await type(nameField(el), name);
    buttonLabelled(el, `Create`)!.click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await nextTick();
};

// The Held to picker is a PrimeVue select under its skin: opened by its own control, then the option clicked in the
// overlay it teleports to the document body.
const pickHeldTo = async (el: HTMLElement, label: string): Promise<void> => {
    // The panel points at its trigger and closes on one with no size, which is every element jsdom lays out.
    const trigger = el.querySelector<HTMLButtonElement>(`button[aria-haspopup="listbox"][aria-label="Held to"]`) ?? byAriaLabel(el, `Held to`)!;
    trigger.getBoundingClientRect = () => new DOMRect(0, 0, 288, 32);
    trigger.click();
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
    const option = await waitFor(() => {
        const found = [...document.body.querySelectorAll(`[role="option"]`)].find((entry) => (entry.textContent ?? ``).trim() === label);
        expect(found, `no option labelled ${label}`).toEqual(expect.any(Object));
        return found as HTMLElement;
    });
    option.click();
    await nextTick();
};

// Found by role, so a stray button whose label matches a heading can't satisfy it.
const openTab = async (el: HTMLElement, label: string): Promise<void> => {
    const tab = await waitFor(() => {
        const found = [...el.querySelectorAll(`[role="tab"]`)].find((entry) => (entry.textContent ?? ``).trim() === label);
        expect(found, `no tab labelled ${label}`).toEqual(expect.any(Object));
        return found!;
    });
    tab.dispatchEvent(new MouseEvent(`click`, { bubbles: true }));
    // A macrotask, not a tick count, since the panel behind a pill swaps several awaits deep.
    await new Promise((resolve) => setTimeout(resolve));
    await nextTick();
};

beforeEach(() => {
    save.mockClear();
    saveProfile.mockClear();
    profiles.value = [];
    peopleRight.value = true;
    remove.mockClear();
    roles.value = [];
    connected.value = [];
    isLoading.value = false;
    nestedRepos.value = [];
    accounts.value = [account(`reddit-work`, `reddit`), account(`x-company`, `x`), account(`reddit-personal`, `reddit`)];
    tree.value = [
        { name: `app`, path: `app`, type: `dir`, children: [{ name: `src`, path: `app/src`, type: `dir`, children: [] }] },
        { name: `docs`, path: `docs`, type: `dir`, children: [] },
        // Ignored, so it must not be offered as a fence target.
        { name: `node_modules`, path: `node_modules`, type: `dir`, ignored: true },
        { name: `README.md`, path: `README.md`, type: `file` },
    ];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`marks a role whose every account is signed out`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    await openRole(el, `work`);
    expect(text(el)).toContain(`Not signed in`);
});

it(`writes the open role to the address, so a reload lands on it`, async () => {
    roles.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    await openRole(el, `work`);
    await waitFor(() => expect(router.currentRoute.value.query[`open`]).toBe(`work`));
});

it(`opens the first role once the list has landed, with the shared selected-row mark`, async () => {
    isLoading.value = true;
    const el = mount();

    roles.value = [
        { id: `work`, capabilities: [] },
        { id: `home`, capabilities: [] },
    ];
    isLoading.value = false;
    await nextTick();

    const first = tileFor(el, `work`);
    expect(first.getAttribute(`aria-pressed`)).toBe(`true`);
    expect(tileFor(el, `home`).getAttribute(`aria-pressed`)).toBe(`false`);
    expect(first.classList.contains(`ui-row-select-on`)).toBe(true);
    expect(first.classList.contains(`ui-row-select-horizontal`)).toBe(false);
    expect(text(el)).toContain(`Speaks through`);
    await waitFor(() => expect(router.currentRoute.value.query[`open`]).toBe(`work`));
});

it(`leaves a role the reader closed closed when the list refreshes`, async () => {
    roles.value = [
        { id: `work`, capabilities: [] },
        { id: `home`, capabilities: [] },
    ];
    const el = mount();
    await nextTick();
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);

    tileFor(el, `work`).click();
    await nextTick();
    roles.value = [...roles.value];
    await nextTick();

    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`false`);
    expect(tileFor(el, `home`).getAttribute(`aria-pressed`)).toBe(`false`);
    expect(text(el)).not.toContain(`Speaks through`);
});

it(`does not mark a role that can reach at least one signed-in account`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    connected.value = [`x-company`];
    const el = mount();
    await openRole(el, `work`);
    expect(text(el)).not.toContain(`Not signed in`);
});

it(`says nothing about a role that holds no accounts`, async () => {
    roles.value = [{ id: `docs`, capabilities: [] }];
    const el = mount();
    await openRole(el, `docs`);
    // The open role's own panel: No accounts is the built-in's own name, said on its tile, not this card's panel.
    const panel = el.querySelector<HTMLElement>(`#${tileFor(el, `docs`).getAttribute(`aria-controls`)}`)!;
    const rendered = text(panel);
    expect(rendered).not.toContain(`No accounts`);
    expect(rendered).not.toContain(`can't post`);
});

// Every turn wears somebody, so the page's own grid leads with the two roles every sandbox has: tiles like any other,
// but locked, and opening one shows what it reaches rather than an editor.
const builtInTile = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll<HTMLButtonElement>(`[role="group"][aria-label="Your roles"] button[aria-pressed]`)].find(
        (button) => button.getAttribute(`aria-label`) === label,
    );
it(`shows the built-in roles as locked tiles in the grid`, async () => {
    roles.value = [];
    const el = mount();
    await nextTick();
    expect(builtInTile(el, `All accounts`)?.textContent).toContain(`All accounts`);
    expect(builtInTile(el, `No accounts`)?.textContent).toContain(`No accounts`);
    expect(removeControlFor(el, `Full access`)).toBeUndefined();
    expect(removeControlFor(el, `No accounts`)).toBeUndefined();
    // With none of its own, the sandbox still says what that means, and adding one is the step asked for.
    expect(text(el)).toContain(`No roles yet`);
});

it(`opens a built-in read-only, and writes it to the address`, async () => {
    roles.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    await waitFor(() => expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`));
    builtInTile(el, `No accounts`)!.click();
    await waitFor(() => expect(builtInTile(el, `No accounts`)!.getAttribute(`aria-pressed`)).toBe(`true`));
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`false`);
    const panel = el.querySelector<HTMLElement>(`#${builtInTile(el, `No accounts`)!.getAttribute(`aria-controls`)}`)!;
    expect(text(panel)).toContain(`can't post`);
    expect(text(panel)).toContain(`can't be edited or removed`);
    // No editor: no rename, no tabs.
    expect(panel.querySelector(`h3 button`)).toBeNull();
    expect(panel.querySelector(`[role="tab"]`)).toBeNull();
    await waitFor(() => expect(router.currentRoute.value.query[`open`]).toBe(`no-accounts`));
});

it(`lands on a built-in the address names`, async () => {
    roles.value = [{ id: `work`, capabilities: [] }];
    const el = mount({ open: `full-access` });
    await waitFor(() => expect(builtInTile(el, `All accounts`)!.getAttribute(`aria-pressed`)).toBe(`true`));
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`false`);
});

it(`does not list account names under a closed role`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    tileFor(el, `work`).click();
    await nextTick();
    const rendered = text(el);
    expect(rendered).not.toContain(`reddit-work`);
    expect(rendered).not.toContain(`x-company`);
});

it(`offers to add a role when this sandbox has no accounts at all`, () => {
    accounts.value = [];
    expect(buttonLabelled(mount(), `Add a role`)?.disabled).toBe(false);
});

it(`saves one role holding accounts on two different sites`, async () => {
    const el = mount();
    await addRole(el, `Work`);
    // Opens on "Speaks as" by default, so no tab switch is needed before choosing accounts.
    await chooseAccounts(el);
    buttonLabelled(el, `reddit-work`)!.click();
    buttonLabelled(el, `x-company`)!.click();

    await waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
    expect(save.mock.calls.at(-1)![0]).toMatchObject({ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] });
});

it(`asks only for a name, then opens the role it made`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a role`)!.click();
    await nextTick();

    const asked = text(el);
    expect(asked).not.toContain(`Run commands`);
    expect(asked).not.toContain(`System prompt`);

    await type(nameField(el), `Work`);
    buttonLabelled(el, `Create`)!.click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ id: `work`, label: `Work`, capabilities: [] });

    await nextTick();
    expect(text(el)).toContain(`Speaks through`);
});

it(`offers where it opens and the profile that holds it when a role is open`, async () => {
    const el = mount();
    await addRole(el, `Work`);
    await openTab(el, `Access`);
    const rendered = text(el);
    expect(rendered).toContain(`Starts in`);
    expect(rendered).toContain(`What it may reach`);
    expect(rendered).toContain(`No profile holds it`);
    // No switch of its own: what it may reach is a profile's, never the card's.
    expect(rendered).not.toContain(`Run commands`);
    expect(rendered).not.toContain(`Only these folders`);
});

it(`states that every session works in its own copy, and offers no choice about it`, async () => {
    const el = mount();
    await addRole(el, `Work`);
    await openTab(el, `Access`);
    const rendered = text(el);
    expect(rendered).toContain(`its own copy of the workspace`);
    expect(rendered).not.toContain(`Whatever started it`);
    expect(rendered).not.toContain(`The shared workspace`);
});

it(`names the profiles that hold a role, and moves it onto another one`, async () => {
    roles.value = [{ id: `review`, label: `Reviewer`, capabilities: [] }];
    profiles.value = [
        { id: `read-only`, label: `Read only`, tools: { files: `read`, shell: false }, roles: [`review`], origin: `sandbox` },
        { id: `interns`, label: `Interns`, origin: `sandbox` },
    ];
    const el = mount({ open: `review` });
    await openRole(el, `review`);
    await openTab(el, `Access`);
    expect(text(el)).toContain(`Read only`);
    expect(text(el)).toContain(`Read-only`);

    const picker = byAriaLabel(el, `Held to`)!;
    expect(picker).toEqual(expect.any(Object));
    // Off the profile it was on, then onto the one picked: never on two at once.
    await pickHeldTo(el, `Interns`);
    await waitFor(() => expect(saveProfile).toHaveBeenCalledTimes(2));
    expect(saveProfile.mock.calls[0]![0]).toMatchObject({ id: `read-only`, roles: [] });
    expect(saveProfile.mock.calls[1]![0]).toMatchObject({ id: `interns`, roles: [`review`] });
    // The card itself is never written for it.
    expect(save).not.toHaveBeenCalled();
});

it(`leaves the profile picker to someone who runs people and access`, async () => {
    peopleRight.value = false;
    roles.value = [{ id: `review`, capabilities: [] }];
    const el = mount({ open: `review` });
    await openRole(el, `review`);
    await openTab(el, `Access`);
    expect(byAriaLabel(el, `Held to`)).toBeUndefined();
    expect(text(el)).toContain(`Only someone who runs people and access moves a role onto another profile.`);
});

// Nobody picks assistants per person any more: a role is handed over by the area its starting folder sits in. That
// consequence is not readable off a folder name, so the editor says it where the folder is chosen.
it(`says which areas gain the role, and that starting nowhere keeps it the owner's`, async () => {
    const el = mount();
    await addRole(el, `Docs`);
    await openTab(el, `Access`);
    expect(text(el)).toContain(`only someone who holds the whole workspace can talk to it`);

    await openFolderPicker(el, `Starts in`);
    folderRow(`docs`)!.click();
    await waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
    await nextTick();
    expect(save.mock.calls.at(-1)![0].workspace).toEqual({ startIn: `docs` });
    expect(text(el)).toContain(`Anyone granted Handbook can talk to it.`);
});

it(`closes the selected role by clicking its tile, and reopens it by clicking again`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await nextTick();
    expect(text(el)).toContain(`Speaks through`);
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);

    tileFor(el, `work`).click();
    await nextTick();
    expect(text(el)).not.toContain(`Speaks through`);
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`false`);

    await openRole(el, `work`);
    expect(text(el)).toContain(`Speaks through`);
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);
});

it(`switches the details to the picked role and saves the previous role's queued edit`, async () => {
    roles.value = [
        { id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] },
        { id: `home`, label: `Home`, capabilities: [`reddit-personal`] },
    ];
    const el = mount();
    await openRole(el, `work`);
    byAriaLabel(el, `Stop speaking through reddit-work`)!.click();
    await nextTick();
    expect(save).not.toHaveBeenCalled();

    tileFor(el, `home`).click();
    await nextTick();
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`false`);
    expect(tileFor(el, `home`).getAttribute(`aria-pressed`)).toBe(`true`);
    expect(el.querySelectorAll(`button[aria-label="Remove this role"]`)).toHaveLength(2);
    const details = document.getElementById(tileFor(el, `home`).getAttribute(`aria-controls`)!);
    expect(details!.querySelector(`button[aria-label="Remove this role"]`)).toBeNull();
    expect(text(el)).toContain(`reddit-personal`);
    expect(text(el)).not.toContain(`x-company`);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(save.mock.calls).toEqual([[{ id: `work`, label: `Work`, capabilities: [`x-company`] }]]);
});

it(`leaves the creation form when an existing role is picked`, async () => {
    roles.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    buttonLabelled(el, `Add a role`)!.click();
    await nextTick();
    await type(nameField(el), `Unfinished`);

    await openRole(el, `work`);
    expect(nameField(el)).toBeNull();
    expect(text(el)).toContain(`Speaks through`);
    expect(save).not.toHaveBeenCalled();
});

it(`removes the selected role without saving its queued edit afterwards`, async () => {
    roles.value = [
        { id: `work`, capabilities: [`reddit-work`] },
        { id: `home`, capabilities: [] },
    ];
    remove.mockImplementationOnce(async (id) => {
        roles.value = roles.value.filter((role) => role.id !== id);
        return { ok: true };
    });
    const el = mount();
    await openRole(el, `work`);
    byAriaLabel(el, `Stop speaking through reddit-work`)!.click();
    await nextTick();
    removeControl(el, `work`).click();
    await nextTick();
    buttonLabelled(document.body, `Remove role`)!.click();
    await waitFor(() => expect(remove).toHaveBeenCalledWith(`work`));
    await nextTick();
    expect(text(el)).not.toContain(`Speaks through`);
    expect(roles.value).toEqual([{ id: `home`, capabilities: [] }]);

    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(save).not.toHaveBeenCalled();
});

it(`removes another role from its selector while the selected role's edit still saves`, async () => {
    roles.value = [
        { id: `work`, capabilities: [`reddit-work`, `x-company`] },
        { id: `home`, capabilities: [] },
    ];
    remove.mockImplementationOnce(async (id) => {
        roles.value = roles.value.filter((role) => role.id !== id);
        return { ok: true };
    });
    const el = mount();
    await openRole(el, `work`);
    byAriaLabel(el, `Stop speaking through reddit-work`)!.click();
    await nextTick();
    removeControl(el, `home`).click();
    await nextTick();
    expect(tileFor(el, `home`).getAttribute(`aria-pressed`)).toBe(`false`);
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);
    buttonLabelled(document.body, `Remove role`)!.click();
    await waitFor(() => expect(remove).toHaveBeenCalledWith(`home`));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0]).toEqual({ id: `work`, capabilities: [`x-company`] });
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);
});

// The chat rail's Edit role links here naming one; the reader lands on it open, and closing it stays closed.
it(`lands on the role a link names already open, once`, async () => {
    roles.value = [
        { id: `work`, capabilities: [`reddit-work`] },
        { id: `home`, capabilities: [] },
    ];
    const el = mount({ open: `work` });
    await nextTick();
    expect(text(el)).toContain(`Speaks through`);

    tileFor(el, `work`).click();
    await nextTick();
    roles.value = [...roles.value];
    await nextTick();
    expect(text(el)).not.toContain(`Speaks through`);
});

it(`shows one of the role's three questions at a time`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openRole(el, `work`);

    expect(text(el)).toContain(`Speaks through`);
    expect(text(el)).not.toContain(`What it may reach`);
    expect(text(el)).not.toContain(`Its own skills`);

    await openTab(el, `Access`);
    expect(text(el)).toContain(`What it may reach`);
    expect(text(el)).not.toContain(`Speaks through`);

    await openTab(el, `What it is told`);
    expect(text(el)).toContain(`Its own skills`);
    expect(text(el)).not.toContain(`What it may reach`);
});

it(`keeps repository switches full-size beside long names without changing which repositories are carried`, async () => {
    const repo = `workspace-with-a-long-name/packages/customer-support-service`;
    nestedRepos.value = [repo];
    roles.value = [{ id: `work`, capabilities: [], context: { repos: [] } }];
    const el = mount();
    await openRole(el, `work`);
    await openTab(el, `Runs on`);

    const switches = [...el.querySelectorAll<HTMLInputElement>(`label input[type="checkbox"]`)];
    expect(switches).toHaveLength(2);
    expect(switches.map((input) => input.checked)).toEqual([false, false]);
    for (const input of switches) {
        expect(input.closest(`[data-pc-name="toggleswitch"]`)!.classList.contains(`shrink-0`)).toBe(true);
    }
    expect(text(el)).toContain(repo);
    expect(save).not.toHaveBeenCalled();

    toggleSwitch(el, repo);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].context).toEqual({ repos: [repo] });
    toggleSwitch(el, `Every repository`);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(save.mock.calls[1]![0].context).toBeUndefined();
    expect(el.querySelectorAll(`label input[type="checkbox"]`)).toHaveLength(1);
});

it(`names the open role in its heading, and turns that name into a field only when pressed`, async () => {
    roles.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }];
    const el = mount();
    // A tile is only a selector: nothing on it renames; the open role's heading is the one rename.
    expect(tileFor(el, `work`).querySelector(`input`)).toBeNull();
    await openRole(el, `work`);
    expect(nameControl(el, `Work`)?.tagName).toBe(`BUTTON`);
    expect(el.querySelector(`input[aria-label="Role name"]`)).toBeNull();
    nameControl(el, `Work`)!.click();
    await nextTick();
    expect(el.querySelector(`input[aria-label="Role name"]`)).not.toBeNull();
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);
    expect(el.querySelector(`button button, button input`)).toBeNull();
});

// Rename writes the whole role, not just the label; dropping the accounts would be a silent loss.
it(`renames a role on Enter, keeping the rest of its role`, async () => {
    roles.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    await openRole(el, `work`);
    nameControl(el, `Work`)!.click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input[aria-label="Role name"]`)!;
    await type(field, `Work crew`);
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const written = save.mock.calls[0]![0];
    expect(written).toMatchObject({ id: `work`, label: `Work crew` });
    // Spread: what the form hands over is Vue's reactive array, which no array matcher reads as a plain one.
    expect([...written.capabilities]).toEqual([`reddit-work`, `x-company`]);
    await nextTick();
    expect(tileFor(el, `work`).getAttribute(`aria-label`)).toBe(`Work crew`);
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);
});

it(`abandons a rename on Escape without writing`, async () => {
    roles.value = [{ id: `work`, label: `Work`, capabilities: [] }];
    const el = mount();
    await openRole(el, `work`);
    nameControl(el, `Work`)!.click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input[aria-label="Role name"]`)!;
    await type(field, `Nope`);
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
    await nextTick();
    expect(save).not.toHaveBeenCalled();
    expect(text(el)).toContain(`Work`);
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);
});

it(`keeps a refused rename open in the heading so it can be retried`, async () => {
    roles.value = [{ id: `work`, label: `Work`, capabilities: [] }];
    save.mockRejectedValueOnce(new Error(`Write unavailable`));
    const el = mount();
    await openRole(el, `work`);
    nameControl(el, `Work`)!.click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input[aria-label="Role name"]`)!;
    await type(field, `Work crew`);
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    // The refusal floats on the document body, so a card that clips cannot cut it in half.
    await waitFor(() => expect(document.body.querySelector(`[role="alert"]`)?.textContent).toContain(`Write unavailable`));
    expect(field.value).toBe(`Work crew`);
    expect(tileFor(el, `work`).getAttribute(`aria-label`)).toBe(`Work`);
    expect(tileFor(el, `work`).getAttribute(`aria-pressed`)).toBe(`true`);

    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await waitFor(() => expect(el.querySelector(`input[aria-label="Role name"]`)).toBeNull());
    expect(tileFor(el, `work`).getAttribute(`aria-label`)).toBe(`Work crew`);
    expect(save).toHaveBeenCalledTimes(2);
});

it(`saves an open role as soon as a switch is flipped, with no Save button`, async () => {
    nestedRepos.value = [`app`];
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openRole(el, `work`);
    await openTab(el, `Runs on`);
    expect(buttonLabelled(el, `Save`)).toBeUndefined();

    toggleSwitch(el, `Every repository`);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].context).toEqual({ repos: [] });
});

it(`writes nothing when a role is only opened`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openRole(el, `work`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(save).not.toHaveBeenCalled();
});

it(`saves no place for a role that opens at the root`, async () => {
    const el = mount();
    await addRole(el, `Work`);
    expect(save.mock.calls[0]![0].workspace).toBeUndefined();
});

it(`describes how bounded a role is on its selector, from the profile that holds it`, async () => {
    roles.value = [{ id: `visitor`, capabilities: [] }];
    profiles.value = [{ id: `public`, tools: { files: `read`, shell: false }, roles: [`visitor`], origin: `sandbox` }];
    const el = mount();
    const description = document.getElementById(tileFor(el, `visitor`).getAttribute(`aria-describedby`)!);
    expect(text(description!)).toContain(`Read-only`);
});

it(`refuses a new role named after a built-in`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    buttonLabelled(el, `Add a role`)!.click();
    await nextTick();
    await type(nameField(el), `Full access`);
    expect(text(el)).toContain(`"Full access" is a built-in role`);
    buttonLabelled(el, `Create`)!.click();
    await nextTick();
    expect(save).not.toHaveBeenCalled();
});

it(`refuses a new role whose name is already taken`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    buttonLabelled(el, `Add a role`)!.click();
    await nextTick();
    await type(nameField(el), `Work`);
    expect(text(el)).toContain(`You already have a role called work`);
    buttonLabelled(el, `Create`)!.click();
    await nextTick();
    expect(save).not.toHaveBeenCalled();
});

it(`does not repeat the site under an account already named after it`, async () => {
    accounts.value = [account(`reddit`, `reddit`), account(`main-account`, `reddit`)];
    connected.value = [`reddit`, `main-account`];
    const el = mount();
    await addRole(el, `Work`);
    await chooseAccounts(el);
    expect(text(buttonLabelled(el, `reddit`)!).replace(/\s+/g, ` `).trim()).toBe(`reddit`);
    expect(text(buttonLabelled(el, `main-account`)!)).toContain(`reddit`);
});

it(`keeps every account out of the form until the chooser is opened`, async () => {
    const el = mount();
    await addRole(el, `Work`);
    expect(text(el)).not.toContain(`reddit-personal`);
    await chooseAccounts(el);
    expect(text(el)).toContain(`reddit-personal`);
});

it(`shows only the accounts a role speaks through when it is opened for editing`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openRole(el, `work`);
    expect(text(el)).toContain(`reddit-work`);
    expect(text(el)).not.toContain(`x-company`);
});

it(`drops an account when its chip is clicked`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    await openRole(el, `work`);
    byAriaLabel(el, `Stop speaking through reddit-work`)!.click();
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].capabilities).toEqual([`x-company`]);
});

it(`narrows the chooser by name or site`, async () => {
    // Enough accounts to make the filter field appear (shown only once the list exceeds a glance).
    accounts.value = [...accounts.value, ...[`a`, `b`, `c`, `d`, `e`].map((suffix) => account(`spam-${suffix}`, `reddit`))];
    const el = mount();
    await addRole(el, `Work`);
    await chooseAccounts(el);
    await type(el.querySelector<HTMLInputElement>(`input[aria-label="Filter accounts"]`)!, `x-comp`);
    expect(text(el)).toContain(`x-company`);
    expect(text(el)).not.toContain(`reddit-personal`);
});

// Two facts about the FILE, not the text (which lives in the kit, stubbed above): a role following the sandbox stores
// nothing, and a role given its own base stores exactly that.
it(`stores nothing about the prompt for a role that follows the sandbox`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openRole(el, `work`);
    // Its one account's chip takes the account off: an edit, so a save.
    buttonLabelled(el, `reddit-work`)!.click();

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].systemPromptMode).toBeUndefined();
});

it(`stores the base a role was given one of its own`, async () => {
    roles.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openRole(el, `work`);
    await openTab(el, `What it is told`);

    await openTab(el, `Claude`);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].systemPromptMode).toBe(`claude`);
});

it(`adds a role's own skill through the same row and the same editor as the skills list`, async () => {
    roles.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    await openRole(el, `work`);
    await openTab(el, `What it is told`);

    // The list's own action, a filled button in its header, as on the Skills page: not a line among the rows.
    const add = buttonLabelled(el, `Write a skill`)!;
    expect(add.className).not.toContain(`w-full`);
    expect(add.closest(`section`)?.firstElementChild?.contains(add)).toBe(true);

    add.click();
    await nextTick();
    const rendered = text(el);
    expect(rendered).toContain(`When to use it`);
    expect(rendered).toContain(`Instructions`);
    expect(rendered).toContain(`Add skill`);
    expect(el.querySelector(`[data-skill-draft]`)).not.toBeNull();
});

// The checklist that lets a role starve a small-context model of everything it does not need. Named with the exact
// titles the chat's own "Sent ahead of your message" fold shows, so the two surfaces stay one vocabulary.
it(`drops a preamble note by the name the transcript gives it`, async () => {
    const dropped = TURN_BRIEFING_NOTES[0]!;
    roles.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    await openRole(el, `work`);
    await openTab(el, `What it is told`);

    expect(text(el)).toContain(dropped.when);
    toggleSwitch(el, dropped.label);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].briefing).toEqual({ omit: [dropped.id] });
    // The consequence replaces the "when" line only once turning it off is the choice that was made.
    expect(text(el)).toContain(dropped.cost);
});

it(`opens a stored role on what it drops, and stores nothing once it drops none of it`, async () => {
    const dropped = TURN_BRIEFING_NOTES[0]!;
    roles.value = [{ id: `work`, capabilities: [`reddit-work`], briefing: { omit: [dropped.id] } }];
    const el = mount();
    await openRole(el, `work`);
    await openTab(el, `What it is told`);

    expect(text(el)).toContain(dropped.cost);
    // Switched back on, so the role ends up dropping nothing: the file must then say nothing rather than an empty list.
    toggleSwitch(el, dropped.label);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].briefing).toBeUndefined();
});

it(`names the notes no role may drop, so the checklist reads as complete`, async () => {
    roles.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    await openRole(el, `work`);
    await openTab(el, `What it is told`);

    const fixture = TURN_BRIEFING_FIXTURES[0]!;
    expect(text(el)).not.toContain(fixture.why);
    buttonLabelled(el, `always sent`)!.click();
    await nextTick();

    expect(text(el)).toContain(fixture.label);
    expect(text(el)).toContain(fixture.why);
});
