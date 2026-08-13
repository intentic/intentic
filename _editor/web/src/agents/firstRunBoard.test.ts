// @vitest-environment jsdom
//
// THE FIRST SCREEN, MOUNTED. On a fresh workspace the desktop now lands here (router/index.ts) straight out of
// setup, so what the empty board renders is the whole of somebody's first impression — and the two things that
// make it work are easy to break silently: that a starter FILLS the composer rather than dispatching an agent,
// and that a filled composer is what enables the send. Both are asserted against the real component.
import { VueQueryPlugin } from "@tanstack/vue-query";
import { afterEach, expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import { useChat } from "../composables/chat/useChat";
import { queryClient } from "../composables/queryPersistence";
import { router } from "../router";
import AgentsView from "./AgentsView.vue";

// The same import-time globals the other mounted-component tests stand up (see startAgent.test.ts).
// matches:false keeps the device DESKTOP, which is the form factor this landing is about.
vi.hoisted(() => {
    globalThis.Element.prototype.scrollIntoView ??= (): void => {};
    globalThis.ResizeObserver ??= class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
    };
    globalThis.matchMedia ??= ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
    })) as unknown as typeof globalThis.matchMedia;
    globalThis.window.env ??= {
        production: false,
        api: { url: `http://localhost` },
        auth: { googleClientId: `` },
        analytics: { posthogKey: ``, posthogHost: `` },
        afterSignOut: ``,
    };
});

// Unmounted after each test: the board registers its Mod+Z / filter commands in a MODULE-level registry and
// disposes them on unmount, so a second mount in the same file throws "already registered" without this.
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
    for (const app of mounted.splice(0)) {
        app.unmount();
    }
});

const mount = (component: unknown): HTMLElement => {
    const el = document.createElement(`div`);
    document.body.appendChild(el);
    const app = createApp({ render: () => h(component as never) });
    app.component(`Icon`, { render: () => null });
    app.directive(`tooltip`, {});
    app.use(router);
    app.use(VueQueryPlugin, { queryClient });
    app.mount(el);
    mounted.push(app);
    return el;
};

const composerOf = (el: HTMLElement): HTMLTextAreaElement =>
    el.querySelector<HTMLTextAreaElement>(`textarea[aria-label="What should the first agent do?"]`)!;
const starterNamed = (el: HTMLElement, label: string): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.trim() === label)!;
const sendButton = (el: HTMLElement): HTMLButtonElement =>
    [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Start agent`))!;

it(`asks for a task instead of describing the board, and cannot be sent empty`, async () => {
    const board = mount(AgentsView);
    await nextTick();

    expect(board.textContent).toContain(`What should the first agent do?`);
    expect(composerOf(board)).not.toBeNull();
    expect(composerOf(board).value).toBe(``);
    // Nothing to send yet — the one state where the primary action must refuse.
    expect(sendButton(board).disabled).toBe(true);
});

it(`suggests getting code in while the workspace is empty, and a starter fills the box rather than sending`, async () => {
    const board = mount(AgentsView);
    await nextTick();

    // No repos and no changes in this mount, so the suggestions are the get-your-code-in pair.
    const starter = starterNamed(board, `Bring in my code`);
    expect(starter).toBeDefined();
    expect(starterNamed(board, `Start a new project`)).toBeDefined();

    const before = useChat().conversations.value.length;
    starter.click();
    await nextTick();

    // FILLED, NOT SENT: the composer holds the prompt, the send is now live, and no agent was started.
    expect(composerOf(board).value).toContain(`Clone my repository into this workspace`);
    expect(sendButton(board).disabled).toBe(false);
    expect(useChat().conversations.value).toHaveLength(before);
    // Still the first-run screen — filling the box is not starting anything.
    expect(board.textContent).toContain(`What should the first agent do?`);
});
