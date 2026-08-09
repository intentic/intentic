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

// Typing into a v-model field is a value assignment plus the event Vue listens for.
const type = async (field: HTMLInputElement, value: string): Promise<void> => {
    field.value = value;
    field.dispatchEvent(new Event(`input`));
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
    buttonLabelled(el, `reddit-work`)!.click();
    buttonLabelled(el, `x-company`)!.click();
    await nextTick();
    buttonLabelled(el, `Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).toMatchObject({ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] });
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
    expect(text(buttonLabelled(el, `reddit`)!).replace(/\s+/g, ` `).trim()).toBe(`reddit`);
    // ...and still says it where the id does not, which is the whole reason the line exists.
    expect(text(buttonLabelled(el, `main-account`)!)).toContain(`reddit`);
});

// Posture is only worth recording when it RESTRICTS: "publish" is what every account does today, and writing it
// down would put a field in the committed card that means nothing.
it(`leaves posture off a persona that publishes`, async () => {
    const el = mount();
    buttonLabelled(el, `Add a persona`)!.click();
    await nextTick();
    await type(nameField(el), `Work`);
    buttonLabelled(el, `Add persona`)!.click();
    await vi.waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]![0]).not.toHaveProperty(`posture`);
});
