// @vitest-environment jsdom
//
// jsdom because every property worth pinning here is about what the surface SAYS, and the two it says wrong are
// the two that cost something. A persona whose accounts are all signed out is the ordinary state of a freshly
// cloned workspace, and painting it as working is how someone schedules a wake that silently cannot post. A
// persona is also not per-site — one card holds a Reddit account AND an X account — and a form that quietly sent
// one of them would look identical in the list and behave differently at 3am.
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
    byAriaLabel(el, `Edit this persona`)!.click();
    await nextTick();
    expect(text(el)).toContain(`reddit-work`);
    expect(text(el)).not.toContain(`x-company`);
});

// Clicking a persona's own account chip takes that account off the card — the summary row is the way to remove
// one without going back into the chooser to hunt for it.
it(`drops an account when its chip is clicked`, async () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`, `x-company`] }];
    const el = mount();
    byAriaLabel(el, `Edit this persona`)!.click();
    await nextTick();
    byAriaLabel(el, `Stop speaking through reddit-work`)!.click();
    await nextTick();
    buttonLabelled(el, `Save`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
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
