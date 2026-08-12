// @vitest-environment jsdom
//
// jsdom because every property worth pinning here is about what the surface SAYS, and the two it says wrong are
// the two that cost something. A persona whose accounts are all signed out is the ordinary state of a freshly
// cloned workspace, and painting it as working is how someone schedules a wake that silently cannot post. A
// persona is also not per-site — one card holds a Reddit account AND an X account — and a form that quietly sent
// one of them would look identical in the list and behave differently at 3am.
import type { WorkspaceTreeEntry } from "@intentic-app/api-contract";
import type { Persona } from "@intentic/sandbox-contract";
import type { BrowserAccount } from "../../composables/extensions/useBrowserAccounts";
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
    // The folder picker's panel is an <AnchoredOverlay>, which watches its own box to stay put. jsdom ships no
    // ResizeObserver, and without one the overlay throws on open — off the assertion path, as an unhandled
    // rejection, which fails the run without failing a test.
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    } as unknown as typeof globalThis.ResizeObserver;
});

const personas = ref<Persona[]>([]);
const connected = ref<string[]>([]);
const save = vi.fn<(persona: Persona) => Promise<unknown>>().mockResolvedValue({ ok: true });
const remove = vi.fn<(id: string) => Promise<unknown>>().mockResolvedValue({ ok: true });

vi.mock(`../../composables/sandbox/usePersonas`, () => ({
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
vi.mock(`../../composables/extensions/useBrowserAccounts`, () => ({
    useBrowserAccounts: () => ({ accounts, accountOf: (id: string) => accounts.value.find((entry) => entry.id === id) }),
}));

// The connectors, computers and MCP connections a card can grant by id. Mocked rather than left real because
// the composable behind it reaches the sandbox client at import time, which has no environment under jsdom.
const capabilities = ref<{ id: string; kind: string }[]>([]);
vi.mock(`../../composables/extensions/useCapabilities`, () => ({ useCapabilities: () => ({ capabilities }) }));

/* The workspace the folder pickers offer. Both of them read the tree straight off the daemon, and both modules
 * on that road (the client, and the query wrapper that gates on the daemon being reachable) touch
 * environment.ts's `window.env` at module-eval — the same edge useAgents.test.ts cuts, for the same reason.
 *
 * Stubbed to a REAL little tree rather than to nothing, because "the picker lists your folders" is the whole of
 * what this control claims and an empty stub would assert only that it renders. The file is here to be filtered
 * out: this is a question about where, and a picker offering README.md is offering an answer that cannot work. */
const tree = ref<WorkspaceTreeEntry[]>([]);
vi.mock(`../../composables/sandbox/sandboxClient`, () => ({ sandboxJson: vi.fn().mockResolvedValue({ entries: [], hidden: 0 }) }));
vi.mock(`../../composables/sandbox/useSandboxQuery`, async () => {
    const { computed, ref: shallow } = await import(`vue`);
    return {
        useSandboxQuery: () => ({
            query: { data: computed(() => ({ root: `/work`, tree: tree.value, hidden: 0 })), isPending: shallow(false) },
            error: shallow(undefined),
        }),
    };
});

const { default: SandboxPersonas } = await import("./SandboxPersonas.vue");

// A logo slug is deliberately absent: <BrandMark> falls to the glyph tier, which is what a site the manifest
// has no card for actually does, and pinning the happy path only would hide that this surface still reads.
const account = (id: string, platform: string): BrowserAccount => ({ id, platform, site: platform, logo: undefined, icon: `globe` });

let app: App | undefined;
// Icon and RouterLink are registered app-wide in the real app; stand-ins keep this off the whole UI plugin and
// the router. RouterLink renders its slot so the "connect an account first" nudge is still readable as text.
const mount = (): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(SandboxPersonas) });
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
    app.mount(el);
    return el;
};

const text = (el: HTMLElement): string => el.textContent ?? ``;
const buttonLabelled = (el: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...el.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));
const nameField = (el: HTMLElement): HTMLInputElement => el.querySelector<HTMLInputElement>(`input`)!;
const byAriaLabel = (el: HTMLElement, label: string): HTMLElement | undefined =>
    el.querySelector<HTMLElement>(`[aria-label="${label}"]`) ?? undefined;

/* A persona's row, reached through the one thing on it with a stable accessible name. The row itself carries no
 * label of its own — it is a settings row, not a control — and adding a test-only attribute to production markup
 * to find it would be inventing a convention this app does not have. */
const rowFor = (el: HTMLElement, id: string): HTMLElement => {
    const persona = personas.value.find((entry) => entry.id === id)!;
    return byAriaLabel(el, `Rename ${persona.label ?? persona.id}`)!.closest(`.ui-row-select`) as HTMLElement;
};
const openCard = async (el: HTMLElement, id: string): Promise<void> => {
    rowFor(el, id).click();
    await nextTick();
};

// Flip one of the powers switches by the label beside it. PrimeVue's ToggleSwitch is a checkbox under its skin.
const toggleSwitch = (el: HTMLElement, label: string): void => {
    const row = [...el.querySelectorAll(`label`)].find((entry) => (entry.textContent ?? ``).includes(label))!;
    row.querySelector<HTMLInputElement>(`input[type="checkbox"]`)!.click();
};

/* One folder's row in an open picker. Searched from the DOCUMENT, not from the mounted element: the panel is an
 * <AnchoredOverlay>, which teleports into the anchor's own document body so it can escape the form's overflow —
 * so a query rooted at the mount finds nothing, whether or not the picker is open. Matched on the exact name so
 * `app` cannot be answered by `app/src`. */
const folderRow = (name: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).trim() === name);

/* Open one of the two folder pickers, by the field it belongs to. Reached through the field's own group rather
 * than by counting "Choose" buttons on the form — the account chooser is labelled "Choose accounts", so the
 * count starts one to the left of where anyone writing the test would expect. Its opener is the last button in
 * the group; the chips for what is already picked come first. */
const openFolderPicker = async (el: HTMLElement, field: string): Promise<void> => {
    const group = el.querySelector<HTMLElement>(`[role="group"][aria-label="${field}"]`)!;
    [...group.querySelectorAll(`button`)].at(-1)!.click();
    await nextTick();
};

// Typing into a v-model field is a value assignment plus the event Vue listens for.
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
    await nextTick();
};

// The account chooser is folded away until it is asked for (a sandbox can hold twenty accounts and the form has
// three other sections), so every test that picks an account opens it first — as a person does.
const chooseAccounts = async (el: HTMLElement): Promise<void> => {
    buttonLabelled(el, `Choose accounts`)?.click();
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
        // Ignored, so it must not be offered: nobody fences a persona to a dependency tree, and on a real
        // workspace these are most of what a walk returns.
        { name: `node_modules`, path: `node_modules`, type: `dir`, ignored: true },
        { name: `README.md`, path: `README.md`, type: `file` },
    ];
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// The cloned-workspace case, and the reason the list carries `connected` at all.
it(`marks a persona whose every account is signed out`, () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    expect(text(mount())).toContain(`Not signed in`);
});

// One connected account is enough to act — the turn simply reaches the one — so this must NOT be marked.
it(`does not mark a persona that can reach at least one signed-in account`, () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    connected.value = [`x-company`];
    expect(text(mount())).not.toContain(`Not signed in`);
});

// The claim the whole layer rests on: a persona spans platforms, so the card it saves carries both accounts.
it(`saves one persona holding accounts on two different sites`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await type(nameField(el), `Work`);
    await chooseAccounts(el);
    buttonLabelled(el, `reddit-work`)!.click();
    buttonLabelled(el, `x-company`)!.click();
    await nextTick();
    buttonLabelled(el, `Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toMatchObject({ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] });
});

/* The form is now three questions rather than one, and the two new sections are the whole feature — a card that
 * renders its accounts and silently drops the powers is indistinguishable, on screen, from one that has no
 * powers to set. This is the check that the sections are actually there and labelled. */
it(`offers the powers and where-it-works sections when a card is open`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    const rendered = text(el);
    expect(rendered).toContain(`What it may do`);
    expect(rendered).toContain(`Run commands`);
    expect(rendered).toContain(`Change the sandbox`);
    expect(rendered).toContain(`Where it works`);
    expect(rendered).toContain(`Only these folders`);
    // The honest caveat about what a folder limit is worth — rendered where it is set, not in documentation.
    expect(rendered).toContain(`not a shell`);
});

/* NINE EQUAL SWITCHES IS A LIST NOBODY READS. They are split by blast radius — what this persona can do to your
 * workspace, then what it can reach beyond it — and the headings are the whole of that idea: without them the
 * grouping is invisible and the section is the flat column it used to be. */
it(`sorts what a persona may do into workspace and outward groups`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    const rendered = text(el);
    expect(rendered).toContain(`In your workspace`);
    expect(rendered).toContain(`Reaching out`);
});

/* WHERE IT WORKS STATES THE ISOLATION RATHER THAN ASKING ABOUT IT. The three-way placement choice is gone, and
 * with it the only control that could put a session on the shared tree — so a card can no longer opt out of the
 * worktree that lets two of them run at once. */
it(`states that every session works in its own copy, and offers no choice about it`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    const rendered = text(el);
    expect(rendered).toContain(`its own copy of the workspace`);
    expect(rendered).not.toContain(`Whatever started it`);
    expect(rendered).not.toContain(`The shared workspace`);
});

/* THE FOLDERS ARE PICKED FROM THE FOLDERS. Both location fields were a text box with a greyed sentence in it,
 * which asks the reader to know what the workspace contains and how the field wants a path spelled — and a typo
 * produced a persona fenced to a folder that does not exist, which refuses everything, silently. */
it(`fences a card to a folder chosen from the workspace tree`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await type(nameField(el), `Docs`);

    // Neither picker shows the tree until it is asked for — the form is a form, not a file browser.
    expect(folderRow(`docs`)).toBeUndefined();
    await openFolderPicker(el, `Only these folders`);

    // The workspace's folders, and only those: the file is not an answer to "where", and the ignored dir is noise.
    expect(folderRow(`docs`)).toBeDefined();
    expect(folderRow(`app`)).toBeDefined();
    expect(folderRow(`README.md`)).toBeUndefined();
    expect(folderRow(`node_modules`)).toBeUndefined();

    folderRow(`docs`)!.click();
    await nextTick();
    buttonLabelled(el, `Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].workspace).toEqual({ folders: [`docs`] });
});

/* THE ROW IS THE DISCLOSURE, and there is no second way in. A pencil that opens what clicking the row also
 * opens is two affordances for one act, and the one people try first is the row. */
it(`opens a card by clicking its row, and closes it by clicking again`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    expect(text(el)).not.toContain(`What it may do`);
    await openCard(el, `work`);
    expect(text(el)).toContain(`What it may do`);
    rowFor(el, `work`).click();
    await nextTick();
    expect(text(el)).not.toContain(`What it may do`);
});

/* A NAME READS AS A NAME until you ask to change it. An input parked in the title permanently makes a settings
 * list look like a form; this is the app's one inline-rename machine, the same one the file tree uses. */
it(`shows the name as text and turns it into a field only when clicked`, async () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`] }];
    const el = mount();
    expect(el.querySelector(`input[aria-label="Name"]`)).toBeNull();
    byAriaLabel(el, `Rename Work`)!.click();
    await nextTick();
    expect(el.querySelector(`input[aria-label="Name"]`)).not.toBeNull();
});

// Enter commits the rename, and the card it writes is the whole card — a rename that dropped the accounts would
// be a rename that silently un-personas somebody.
it(`renames a persona on Enter, keeping the rest of its card`, async () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    byAriaLabel(el, `Rename Work`)!.click();
    await nextTick();
    const field = el.querySelector<HTMLInputElement>(`input[aria-label="Name"]`)!;
    await type(field, `Work crew`);
    field.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Enter`, bubbles: true }));
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toMatchObject({ id: `work`, label: `Work crew`, capabilities: [`reddit-work`, `x-company`] });
});

// Escape is the way out, and it must leave the name alone — the WorkspaceTree convention this shares.
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

/* AN OPEN CARD WRITES AS IT IS CHANGED. There is no Save button on it at all, so if the switch below did not
 * reach the daemon by itself the change would simply be lost when the row closed. */
it(`saves an open card as soon as a switch is flipped, with no Save button`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    expect(buttonLabelled(el, `Save`)).toBeUndefined();

    const runCommands = [...el.querySelectorAll(`input[type="checkbox"]`)];
    expect(runCommands.length).toBeGreaterThan(0);
    toggleSwitch(el, `Run commands`);
    await vi.waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 2000 });
    expect(save.mock.calls[0]![0].powers).toMatchObject({ shell: false });
});

// Merely LOOKING at a card must not write it: opening every persona in the list would otherwise rewrite all of
// them, and a tracked file would show a diff for a page somebody only scrolled past.
it(`writes nothing when a card is only opened`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(save).not.toHaveBeenCalled();
});

/* THE COMMITTED FILE IS A RECORD OF DECISIONS, not a dump of defaults. A card nobody has bounded must save no
 * `powers` at all — otherwise every persona ever created writes ten fields saying "yes" into a tracked file, and
 * the diff on a card someone DID bound is buried in noise on every other card. */
it(`saves no powers block for a card nobody has bounded`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await type(nameField(el), `Work`);
    buttonLabelled(el, `Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0].powers).toBeUndefined();
    expect(save.mock.calls[0]![0].workspace).toBeUndefined();
});

/* A card that IS bounded says so on its row. Which shelf is off is the form's business; what the list owes a
 * reader scanning six cards is which of them are limited at all. */
it(`shows how bounded a card is on its row`, () => {
    personas.value = [
        { id: `visitor`, capabilities: [], powers: { files: `read`, shell: false, web: false, browser: false, delegate: false, sandbox: false } },
    ];
    expect(text(mount())).toContain(`Read-only`);
});

/* A new card landing on a name already taken would UPSERT the other one — the save is by id, so this would read
 * as "added a persona" and silently rewrite a different persona's accounts. */
it(`refuses a new persona whose name is already taken`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await type(nameField(el), `Work`);
    expect(text(el)).toContain(`You already have a persona called work`);
    buttonLabelled(el, `Add persona`)!.click();
    await nextTick();
    expect(save).not.toHaveBeenCalled();
});

/* THE CHIP SAYS EACH THING ONCE. A browser capability is usually named after its site, so a picker that prints
 * the id and the site under it renders "reddit" over "Reddit" — the same word twice, on the commonest chip
 * there is, in the one place a reader is scanning for what tells two accounts APART. The site is worth a word
 * only where the id has not already said it. */
it(`does not repeat the site under an account already named after it`, async () => {
    accounts.value = [account(`reddit`, `reddit`), account(`main-account`, `reddit`)];
    connected.value = [`reddit`, `main-account`];
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await chooseAccounts(el);
    expect(text(buttonLabelled(el, `reddit`)!).replace(/\s+/g, ` `).trim()).toBe(`reddit`);
    // ...and still says it where the id does not, which is the whole reason the line exists.
    expect(text(buttonLabelled(el, `main-account`)!)).toContain(`reddit`);
});

/* THE FORM IS A FORM AND NOT A WALL. Every account this sandbox has signed into used to render as a chip in the
 * second field, so on a box with seventeen of them the switches and the folder fence began a screen below the
 * name they belong to. What is on screen unopened is the ANSWER — the accounts this card speaks through — and the
 * chooser is one click away. */
it(`keeps every account out of the form until the chooser is opened`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    expect(text(el)).not.toContain(`reddit-personal`);
    await chooseAccounts(el);
    expect(text(el)).toContain(`reddit-personal`);
});

// A card that already speaks through two accounts shows those two, and nothing about the other fifteen.
it(`shows only the accounts a card speaks through when it is opened for editing`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const el = mount();
    await openCard(el, `work`);
    expect(text(el)).toContain(`reddit-work`);
    expect(text(el)).not.toContain(`x-company`);
});

// Clicking a persona's own account chip takes that account off the card — the summary row is the way to remove
// one without going back into the chooser to hunt for it.
it(`drops an account when its chip is clicked`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    await openCard(el, `work`);
    byAriaLabel(el, `Stop speaking through reddit-work`)!.click();
    // No Save to press: dropping the chip IS the change, and the card writes itself.
    await vi.waitFor(() => expect(save).toHaveBeenCalled(), { timeout: 2000 });
    expect(save.mock.calls[0]![0].capabilities).toEqual([`x-company`]);
});

/* The filter exists for the reason the fold does: seventeen accounts, of which one is the one being looked for.
 * It matches the site as well as the id, so "reddit" finds every Reddit account whatever each one is called. */
it(`narrows the chooser by name or site`, async () => {
    // Long enough to be worth filtering — the field only appears once the list is past a glance.
    accounts.value = [...accounts.value, ...[`a`, `b`, `c`, `d`, `e`].map((suffix) => account(`spam-${suffix}`, `reddit`))];
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await chooseAccounts(el);
    await type(el.querySelector<HTMLInputElement>(`input[aria-label="Filter accounts"]`)!, `x-comp`);
    expect(text(el)).toContain(`x-company`);
    expect(text(el)).not.toContain(`reddit-personal`);
});
