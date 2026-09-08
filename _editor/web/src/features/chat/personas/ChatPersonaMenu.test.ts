// @vitest-environment jsdom
// Pins what the picker says before a message goes: which persona speaks, whether it can reach an account, and what "no
// persona" means on the attended side.
import type { Persona } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, h, ref } from "vue";
import { IconStub } from "@intentic/ui/testing";

// Needs jsdom: the kit's barrel reads matchMedia at import time (its device tracker), which jsdom lacks.

const personas = ref<Persona[]>([]);
const connected = ref<string[]>([]);

vi.mock(`../../sandbox/personas/usePersonas`, () => ({
    usePersonas: () => ({
        personas,
        connected,
        isConnected: (id: string) => connected.value.includes(id),
        error: ref(undefined),
        isLoading: ref(false),
    }),
}));

// Router stub keeps real hrefs on "manage personas" links; a push spy wouldn't see them at all.
vi.mock(import(`vue-router`), async (importOriginal) => ({
    ...(await importOriginal()),
    useRouter: () => ({ push: vi.fn() }) as never,
    RouterLink: (await import(`../../../testing/routerLinkStub`)).RouterLinkStub as never,
}));

const { default: ChatPersonaMenu } = await import("./ChatPersonaMenu.vue");

let app: App | undefined;
const mount = (picked?: string): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatPersonaMenu, { picked, onPicked: (id: string | undefined) => events.push(id) }) });
    // Icon is registered app-wide in the real app.
    app.component(`Icon`, IconStub);
    app.mount(element);
    return element;
};

const events: (string | undefined)[] = [];
const text = (element: HTMLElement): string => element.textContent ?? ``;
const rowLabelled = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));
// Rows that navigate are anchors, not buttons.
const linkLabelled = (element: HTMLElement, label: string): HTMLAnchorElement | undefined =>
    [...element.querySelectorAll(`a`)].find((link) => (link.textContent ?? ``).includes(label));

beforeEach(() => {
    personas.value = [];
    connected.value = [];
    events.length = 0;
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

// "Anyone" is a row, not the absence of one: an empty pick means keep every account here, but reaches none on a wake.
it(`offers anyone as a pick, and says what it means here`, () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const element = mount(`work`);

    const anyone = rowLabelled(element, `Anyone`)!;
    expect(text(anyone)).toContain(`Every account you've connected`);
    anyone.click();
    expect(events).toEqual([undefined]);
});

// Stays pickable though unsigned in: marking it prevents it from reading as ready when it isn't.
it(`marks a persona whose every account is still signed out`, () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    expect(text(mount())).toContain(`not signed in yet`);

    connected.value = [`x-company`];
    // One signed-in account is enough to act, so the mark clears.
    app?.unmount();
    expect(text(mount())).not.toContain(`not signed in yet`);
});

// Account ids distinguish reddit-work from reddit-personal; a bound mark alone can't.
it(`names the accounts a card holds, and picks it by id`, () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    connected.value = [`reddit-work`, `x-company`];
    const element = mount();

    const row = rowLabelled(element, `Work`)!;
    expect(text(row)).toContain(`reddit-work · x-company`);
    row.click();
    expect(events).toEqual([`work`]);
});

// Same phrase the personas page uses for a bounded card, so the two are recognizably the same card.
it(`says how bounded a card is`, () => {
    personas.value = [
        {
            id: `visitor`,
            capabilities: [`reddit-work`],
            powers: { files: `read`, shell: false, code: false, web: false, browser: false, delegate: false, sandbox: false },
        },
    ];
    expect(text(mount())).toContain(`Read-only`);
});

it(`explains the empty workspace and offers the way in`, () => {
    const element = mount();

    expect(text(element)).toContain(`No personas yet`);
    // A real href, so the row can be hovered, copied, and opened in a new tab like any other link.
    expect(linkLabelled(element, `Set up a persona`)?.getAttribute(`href`)).toBe(`/sandbox/personas`);
});
