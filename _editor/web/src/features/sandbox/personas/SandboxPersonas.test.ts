// @vitest-environment jsdom
// Pins two wordings that cost something if wrong: marking a persona whose accounts are all signed out, and saving both
// accounts on a persona that spans sites. jsdom: renders and reads the mounted DOM.
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import type { Persona } from "@intentic/sandbox-contract";
import type { BrowserAccount } from "../../extensions/useBrowserAccounts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, nextTick, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

vi.hoisted(() => {
    // jsdom has no ResizeObserver; AnchoredOverlay throws on open without one, as an unhandled rejection off the
    // assertion path.
});

const personas = ref<Persona[]>([]);
const connected = ref<string[]>([]);
// Upserts like the real route; creating a persona opens it immediately, so a mock that didn't add the card would leave
// creation tests asserting against a page that never redrew.
const save = vi.fn<(persona: Persona) => Promise<unknown>>().mockImplementation(async (persona) => {
    personas.value = [...personas.value.filter((entry) => entry.id !== persona.id), persona];
    return { ok: true };
});
const remove = vi.fn<(id: string) => Promise<unknown>>().mockResolvedValue({ ok: true });

vi.mock(`./usePersonas`, () => ({
    usePersonas: () => ({
        personas,
        connected,
        isConnected: (id: string) => connected.value.includes(id),
        error: ref(undefined),
        isLoading: ref(false),
        save: { mutateAsync: save, isPending: ref(false) },
        remove: { mutateAsync: remove, isPending: ref(false) },
    }),
}));

const accounts = ref<BrowserAccount[]>([]);
vi.mock(`../../extensions/useBrowserAccounts`, () => ({
    useBrowserAccounts: () => ({ accounts, accountOf: (id: string) => accounts.value.find((entry) => entry.id === id) }),
}));

// Mocked since the real composable reaches the sandbox client at import time, which jsdom has no environment for.
const capabilities = ref<{ id: string; kind: string }[]>([]);
vi.mock(`../../capabilities/connect/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities }) }));

// Stubbed separately from the query mock below, which answers everything with a workspace tree; this suite is about the
// card, so the kit answers empty.
vi.mock(`./usePersonaKit`, async () => {
    const { computed, ref: shallow } = await import(`vue`);
    const idle = { mutateAsync: vi.fn().mockResolvedValue({ ok: true }), isPending: shallow(false) };
    return {
        usePersonaKit: () => ({
            kit: computed(() => ({ prompt: ``, skills: [] })),
            readSkill: vi.fn(),
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
vi.mock(`../client/sandboxClient`, () => ({ sandboxJson: vi.fn().mockResolvedValue({ entries: [], hidden: 0 }) }));
vi.mock(`../client/useSandboxQuery`, async () => {
    const { computed, ref: shallow } = await import(`vue`);
    return {
        useSandboxQuery: () => ({
            query: { data: computed(() => ({ root: `/work`, tree: tree.value, hidden: 0 })), isPending: shallow(false) },
            error: shallow(undefined),
        }),
    };
});

const { default: SandboxPersonas } = await import("./SandboxPersonas.vue");

// No logo, so <BrandMark> falls back to its glyph tier, the same as a site the manifest has no mark for.
const account = (id: string, platform: string): BrowserAccount => ({ id, platform, site: platform, logo: undefined, icon: `globe` });

let app: App | undefined;
// Icon is registered app-wide in the real app; a stand-in keeps this off the whole UI plugin.
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxPersonas) });
    // Carries the icon name through as an attribute, so a test can assert which glyph a row wears, not just that it
    // wears one.
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(el);
    return el;
};

const text = (el: HTMLElement): string => el.textContent ?? ``;
const buttonLabelled = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));
const nameField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input[aria-label="Name this persona"]`)!;
const byAriaLabel = (el: HTMLElement, label: string): HTMLElement | undefined =>
    el.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? undefined;

// Reached through the row's one stable accessible control, since the row itself carries no label; `closest('.group')`
// finds the header, not the drawer wrapper, since both share the class.
const rowFor = (el: HTMLElement, id: string): HTMLElement => {
    const persona = personas.value.find((entry) => entry.id === id)!;
    return byAriaLabel(el, `Rename ${persona.label ?? persona.id}`)!.closest(`.group`) as HTMLElement;
};
// Waits for a tab to render rather than a tick count, since opening settles over an unstable number of them.
const openCard = async (el: HTMLElement, id: string): Promise<void> => {
    rowFor(el, id).click();
    await vi.waitFor(() => expect(el.querySelector(`[role="tab"]`)).not.toBeNull());
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

// Used by every test that needs an open card: name, then Create, then wait for the save.
const addPersona = async (el: HTMLElement, name: string): Promise<void> => {
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await type(nameField(el), name);
    buttonLabelled(el, `Create`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await nextTick();
};

// Found by role, so a stray button whose label matches a heading can't satisfy it.
const openTab = async (el: HTMLElement, label: string): Promise<void> => {
    const tab = await vi.waitFor(() => {
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
    remove.mockClear();
    personas.value = [];
    connected.value = [];
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

it(`marks a persona whose every account is signed out`, () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    expect(text(mount())).toContain(`Not signed in`);
});

it(`does not mark a persona that can reach at least one signed-in account`, () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    connected.value = [`x-company`];
    expect(text(mount())).not.toContain(`Not signed in`);
});

it(`says nothing about a persona that holds no accounts`, () => {
    personas.value = [{ id: `docs`, capabilities: [] }];
    const rendered = text(mount());
    expect(rendered).not.toContain(`No accounts`);
    expect(rendered).not.toContain(`can't post`);
});

it(`does not list account names under a closed persona`, () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    const rendered = text(mount());
    expect(rendered).not.toContain(`reddit-work`);
    expect(rendered).not.toContain(`x-company`);
});

it(`offers to add a persona when this sandbox has no accounts at all`, () => {
    accounts.value = [];
    expect(buttonLabelled(mount(), `Add a persona`)?.disabled).toBe(false);
});

it(`saves one persona holding accounts on two different sites`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    // Opens on "Speaks as" by default, so no tab switch is needed before choosing accounts.
    await chooseAccounts(el);
    buttonLabelled(el, `reddit-work`)!.click();
    buttonLabelled(el, `x-company`)!.click();

    await vi.waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
    expect(save.mock.calls.at(-1)![0]).toMatchObject({ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] });
});

it(`asks only for a name, then opens the card it made`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();

    const asked = text(el);
    expect(asked).not.toContain(`Run commands`);
    expect(asked).not.toContain(`Only these folders`);
    expect(asked).not.toContain(`System prompt`);

    await type(nameField(el), `Work`);
    buttonLabelled(el, `Create`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toEqual({ id: `work`, label: `Work`, capabilities: [] });

    await nextTick();
    expect(text(el)).toContain(`Speaks through`);
});

it(`offers the powers and where-it-works sections when a card is open`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    await openTab(el, `What it may do`);
    const rendered = text(el);
    expect(rendered).toContain(`What it may do`);
    expect(rendered).toContain(`Run commands`);
    expect(rendered).toContain(`Change the sandbox`);
    expect(rendered).toContain(`Where it works`);
    expect(rendered).toContain(`Only these folders`);
    expect(rendered).toContain(`not a shell`);
});

it(`sorts what a persona may do into workspace and outward groups`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    await openTab(el, `What it may do`);
    const rendered = text(el);
    expect(rendered).toContain(`In your workspace`);
    expect(rendered).toContain(`Reaching out`);
});

it(`keeps where-it-works in the workspace group rather than after the outward one`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    await openTab(el, `What it may do`);
    const rendered = text(el);
    expect(rendered.indexOf(`In your workspace`)).toBeLessThan(rendered.indexOf(`Where it works`));
    expect(rendered.indexOf(`Where it works`)).toBeLessThan(rendered.indexOf(`Reaching out`));
});

it(`gives every permission row an icon`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    await openTab(el, `What it may do`);

    // A switch row is a <label> containing a checkbox (ToggleSwitch under its skin).
    const rows = [...el.querySelectorAll(`label`)].filter((row) => row.querySelector(`input[type="checkbox"]`) !== null);
    // 9 = one workspace shelf, five outward ones (two execution backends among them), three grant groups.
    expect(rows).toHaveLength(9);
    for (const row of rows) {
        expect(row.querySelector(`i[data-icon]`)).not.toBeNull();
    }

    // Singled out since its mark (globe) is also claimed by an unbranded account elsewhere.
    const web = rows.find((row) => (row.textContent ?? ``).includes(`Read the web`))!;
    expect(web.querySelector(`i`)?.getAttribute(`data-icon`)).toBe(`globe`);
});

it(`lends the powers rail to the location rows so their icons stay in line`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    await openTab(el, `What it may do`);

    // By the label's text, not icon name: <FolderPicker> draws its own `folder-open` icon inside the Choose button too.
    const labelled = (words: string): Element => {
        const span = [...el.querySelectorAll(`span`)].find(
            (entry) => entry.children.length === 1 && entry.querySelector(`i`) !== null && (entry.textContent ?? ``).trim() === words,
        );
        return span!.querySelector(`i`)!;
    };

    for (const glyph of [labelled(`Starts in`), labelled(`Only these folders`)]) {
        expect(glyph.className).toContain(`w-4`);
        expect(glyph.className).toContain(`text-subtle`);
    }
});

it(`states that every session works in its own copy, and offers no choice about it`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    await openTab(el, `What it may do`);
    const rendered = text(el);
    expect(rendered).toContain(`its own copy of the workspace`);
    expect(rendered).not.toContain(`Whatever started it`);
    expect(rendered).not.toContain(`The shared workspace`);
});

it(`fences a card to a folder chosen from the workspace tree`, async () => {
    const el = mount();
    await addPersona(el, `Docs`);
    await openTab(el, `What it may do`);

    // Neither picker shows the tree until it's opened.
    expect(folderRow(`docs`)).toBeUndefined();
    await openFolderPicker(el, `Only these folders`);

    // Files and ignored directories are excluded from the folder list.
    expect(folderRow(`docs`)).toEqual(expect.any(Object));
    expect(folderRow(`app`)).toEqual(expect.any(Object));
    expect(folderRow(`README.md`)).toBeUndefined();
    expect(folderRow(`node_modules`)).toBeUndefined();

    folderRow(`docs`)!.click();

    await vi.waitFor(() => expect(save.mock.calls.length).toBeGreaterThan(1), { timeout: 2000 });
    expect(save.mock.calls.at(-1)![0].workspace).toEqual({ folders: [`docs`] });
});

it(`opens a card by clicking its row, and closes it by clicking again`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    expect(text(el)).not.toContain(`Speaks through`);
    await openCard(el, `work`);
    expect(text(el)).toContain(`Speaks through`);
    rowFor(el, `work`).click();
    await nextTick();
    expect(text(el)).not.toContain(`Speaks through`);
});

it(`shows one of the card's three questions at a time`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);

    expect(text(el)).toContain(`Speaks through`);
    expect(text(el)).not.toContain(`Run commands`);
    expect(text(el)).not.toContain(`Its own skills`);

    await openTab(el, `What it may do`);
    expect(text(el)).toContain(`Run commands`);
    expect(text(el)).not.toContain(`Speaks through`);

    await openTab(el, `What it is told`);
    expect(text(el)).toContain(`Its own skills`);
    expect(text(el)).not.toContain(`Run commands`);
});

it(`keeps every permission on one screen rather than splitting them across tabs`, async () => {
    personas.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    await openCard(el, `work`);
    await openTab(el, `What it may do`);

    const rendered = text(el);
    expect(rendered).toContain(`In your workspace`);
    expect(rendered).toContain(`Reaching out`);
    expect(rendered).toContain(`Where it works`);
});

it(`shows the name as text and turns it into a field only when clicked`, async () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }];
    const el = mount();
    expect(el.querySelector(`input[aria-label="Name"]`)).toBeNull();
    byAriaLabel(el, `Rename Work`)!.click();
    await nextTick();
    expect(el.querySelector(`input[aria-label="Name"]`)).not.toBeNull();
});

// Rename writes the whole card, not just the label; dropping the accounts would be a silent loss.
it(`renames a persona on Enter, keeping the rest of its card`, async () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    byAriaLabel(el, `Rename Work`)!.click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input[aria-label="Name"]`)!;
    await type(field, `Work crew`);
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]![0]).toMatchObject({ id: `work`, label: `Work crew`, capabilities: [`reddit-work`, `x-company`] });
});

it(`abandons a rename on Escape without writing`, async () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [] }];
    const el = mount();
    byAriaLabel(el, `Rename Work`)!.click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input[aria-label="Name"]`)!;
    await type(field, `Nope`);
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true }));
    await nextTick();
    expect(save).not.toHaveBeenCalled();
    expect(text(el)).toContain(`Work`);
});

it(`saves an open card as soon as a switch is flipped, with no Save button`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    await openTab(el, `What it may do`);
    expect(buttonLabelled(el, `Save`)).toBeUndefined();

    const runCommands = [...el.querySelectorAll(`input[type="checkbox"]`)];
    expect(runCommands.length).toBeGreaterThan(0);
    toggleSwitch(el, `Run commands`);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].powers).toMatchObject({ shell: false });
});

it(`writes nothing when a card is only opened`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(save).not.toHaveBeenCalled();
});

it(`saves no powers block for a card nobody has bounded`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    expect(save.mock.calls[0]![0].powers).toBeUndefined();
    expect(save.mock.calls[0]![0].workspace).toBeUndefined();
});

it(`shows how bounded a card is on its row`, () => {
    personas.value = [
        {
            id: `visitor`,
            capabilities: [],
            powers: { files: `read`, shell: false, code: false, web: false, browser: false, delegate: false, sandbox: false },
        },
    ];
    expect(text(mount())).toContain(`Read-only`);
});

it(`refuses a new persona whose name is already taken`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await type(nameField(el), `Work`);
    expect(text(el)).toContain(`You already have a persona called work`);
    buttonLabelled(el, `Create`)!.click();
    await nextTick();
    expect(save).not.toHaveBeenCalled();
});

it(`does not repeat the site under an account already named after it`, async () => {
    accounts.value = [account(`reddit`, `reddit`), account(`main-account`, `reddit`)];
    connected.value = [`reddit`, `main-account`];
    const el = mount();
    await addPersona(el, `Work`);
    await chooseAccounts(el);
    expect(text(buttonLabelled(el, `reddit`)!).replace(/\s+/g, ` `).trim()).toBe(`reddit`);
    expect(text(buttonLabelled(el, `main-account`)!)).toContain(`reddit`);
});

it(`keeps every account out of the form until the chooser is opened`, async () => {
    const el = mount();
    await addPersona(el, `Work`);
    expect(text(el)).not.toContain(`reddit-personal`);
    await chooseAccounts(el);
    expect(text(el)).toContain(`reddit-personal`);
});

it(`shows only the accounts a card speaks through when it is opened for editing`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    expect(text(el)).toContain(`reddit-work`);
    expect(text(el)).not.toContain(`x-company`);
});

it(`drops an account when its chip is clicked`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    await openCard(el, `work`);
    byAriaLabel(el, `Stop speaking through reddit-work`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].capabilities).toEqual([`x-company`]);
});

it(`narrows the chooser by name or site`, async () => {
    // Enough accounts to make the filter field appear (shown only once the list exceeds a glance).
    accounts.value = [...accounts.value, ...[`a`, `b`, `c`, `d`, `e`].map((suffix) => account(`spam-${suffix}`, `reddit`))];
    const el = mount();
    await addPersona(el, `Work`);
    await chooseAccounts(el);
    await type(el.querySelector<HTMLInputElement>(`input[aria-label="Filter accounts"]`)!, `x-comp`);
    expect(text(el)).toContain(`x-company`);
    expect(text(el)).not.toContain(`reddit-personal`);
});

// Two facts about the FILE, not the text (which lives in the kit, stubbed above): a card following the sandbox stores
// nothing, and a card given its own base stores exactly that.
it(`stores nothing about the prompt for a card that follows the sandbox`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    await openTab(el, `What it may do`);
    toggleSwitch(el, `Run commands`);

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].systemPromptMode).toBeUndefined();
});

it(`stores the base a card was given one of its own`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    await openTab(el, `What it is told`);

    await openTab(el, `Claude`);

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1), { timeout: 2000 });
    expect(save.mock.calls[0]![0].systemPromptMode).toBe(`claude`);
});

it(`adds a persona's own skill through the same row and the same editor as the skills list`, async () => {
    personas.value = [{ id: `work`, capabilities: [] }];
    const el = mount();
    await openCard(el, `work`);
    await openTab(el, `What it is told`);

    const add = buttonLabelled(el, `Write a skill`)!;
    expect(add.className).toContain(`w-full`);

    add.click();
    await nextTick();
    const rendered = text(el);
    expect(rendered).toContain(`When to use it`);
    expect(rendered).toContain(`What it should do`);
    expect(rendered).toContain(`Add skill`);
});
