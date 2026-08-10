// @vitest-environment jsdom
//
// jsdom because this picker's whole job is what it SAYS about a card before the message goes: which persona a
// chat is about to speak as, and — the two the daemon then treats very differently — whether that persona can
// actually reach an account, and what "no persona at all" means on the attended side of the line.
import type { Persona } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h, ref } from "vue";

// The kit's barrel reaches for matchMedia at import time (its device tracker), which jsdom does not have.
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

vi.mock(`../composables/sandbox/usePersonas`, () => ({
    usePersonas: () => ({
        personas,
        connected,
        isConnected: (id: string) => connected.value.includes(id),
        error: ref(undefined),
        isLoading: ref(false),
    }),
}));

// The "manage personas" row navigates; the picker is mounted without a router here, so the push is a spy.
const push = vi.fn();
vi.mock(`vue-router`, () => ({ useRouter: () => ({ push }) }));

const { default: ChatPersonaMenu } = await import("./ChatPersonaMenu.vue");

let app: App | undefined;
const mount = (picked?: string): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatPersonaMenu, { picked, onPicked: (id: string | undefined) => events.push(id) }) });
    // Icon is registered app-wide in the real app.
    app.component(`Icon`, defineComponent({ props: { name: String, spin: Boolean }, render: () => h(`i`) }));
    app.mount(element);
    return element;
};

const events: (string | undefined)[] = [];
const text = (element: HTMLElement): string => element.textContent ?? ``;
const rowLabelled = (element: HTMLElement, label: string): HTMLButtonElement | undefined =>
    [...element.querySelectorAll(`button`)].find((button) => (button.textContent ?? ``).includes(label));

beforeEach(() => {
    personas.value = [];
    connected.value = [];
    events.length = 0;
    push.mockClear();
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

/* "Anyone" is a ROW and not the absence of one, because the empty pick means opposite things either side of
 * the attended line: a chat that names nobody keeps every account, while a wake that names nobody reaches
 * none. The composer is the attended side, and this row is the only place that gets said. */
it(`offers anyone as a pick, and says what it means here`, () => {
    personas.value = [{ id: `work`, capabilities: [`reddit-work`] }];
    const element = mount(`work`);

    const anyone = rowLabelled(element, `Anyone`)!;
    expect(text(anyone)).toContain(`Every account you've connected`);
    anyone.click();
    expect(events).toEqual([undefined]);
});

// The ordinary state of a freshly cloned workspace: the card is real, its accounts are not signed in yet. It
// stays PICKABLE — the bound is still meaningful — but a picker that didn't mark it would read as ready.
it(`marks a persona whose every account is still signed out`, () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    expect(text(mount())).toContain(`not signed in yet`);

    connected.value = [`x-company`];
    // One signed-in account is enough to act, so the mark must go — the turn simply reaches that one.
    app?.unmount();
    expect(text(mount())).not.toContain(`not signed in yet`);
});

// The account ids under the name, because a persona exists precisely to tell `reddit-work` from
// `reddit-personal` and a mark cannot.
it(`names the accounts a card holds, and picks it by id`, () => {
    personas.value = [{ id: `work`, label: `Work`, capabilities: [`reddit-work`, `x-company`] }];
    connected.value = [`reddit-work`, `x-company`];
    const element = mount();

    const row = rowLabelled(element, `Work`)!;
    expect(text(row)).toContain(`reddit-work · x-company`);
    row.click();
    expect(events).toEqual([`work`]);
});

// A bounded card says so where it is picked, in the contract's own words — the same phrase the personas page
// puts on its row, so a card recognised there is the same card here.
it(`says how bounded a card is`, () => {
    personas.value = [
        { id: `visitor`, capabilities: [`reddit-work`], powers: { files: `read`, shell: false, web: false, browser: false, delegate: false, sandbox: false } },
    ];
    expect(text(mount())).toContain(`Read-only`);
});

/* Nothing set up is the ordinary state of a new workspace, and the reason this feature was invisible: the
 * empty picker has to say what it means (this chat reaches everything) and offer the way to the page that
 * fixes it. */
it(`explains the empty workspace and offers the way in`, () => {
    const element = mount();

    expect(text(element)).toContain(`No personas yet`);
    rowLabelled(element, `Set up a persona`)!.click();
    expect(push).toHaveBeenCalledWith(`/sandbox/personas`);
});
