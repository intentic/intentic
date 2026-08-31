// @vitest-environment jsdom
//
// jsdom because every claim here is about what the published page RENDERS, and the load-bearing half of that
// is what it does NOT render. A shared conversation is the one surface of this product an outsider ever
// touches, so "there is nothing on it that reaches back into the workspace" has to be checked against real
// output rather than argued from the source.
import type { RestoredMessage, SharePayload } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, defineComponent, h } from "vue";

// The app's chat components read browser globals at import time (useDevice reads matchMedia, its refs are
// module-level). jsdom provides no matchMedia, so it is stood up before the imports evaluate: the same
// hoist the app's own card test does.
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

const { default: ShareApp } = await import("./ShareApp.vue");
const { ELEMENT_ID } = await import("./payload");

let app: App | undefined;

// Put a conversation in the document the way the daemon does, then boot the page over it.
const publish = (payload: SharePayload | null): HTMLElement => {
    const data = document.createElement(`script`);
    data.id = ELEMENT_ID;
    data.type = `application/json`;
    data.textContent = JSON.stringify(payload);
    document.head.append(data);

    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp(ShareApp);
    // Icon and v-tooltip are registered globally by the page's own boot; stand-ins keep the test off the icon
    // collections, which are 28 KB of data that say nothing about what is on the page.
    app.component(
        `Icon`,
        defineComponent({
            props: { name: String, spin: Boolean },
            render() {
                return h(`i`, { "data-icon": this.name });
            },
        }),
    );
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const conversation = (messages: readonly RestoredMessage[], detail: SharePayload["detail"] = `everything`): SharePayload => ({
    title: `Login redirect fix`,
    sharedAt: 1786372320000,
    detail,
    messages: [...messages],
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    document.head.innerHTML = ``;
});

it(`draws the conversation it was published with: the prompt, the answer's prose, and the work behind it`, () => {
    const element = publish(
        conversation([
            { role: `user`, text: `fix the login redirect loop`, sentAt: 1786372320000 },
            {
                role: `assistant`,
                text: `Found it — the guard **re-ran** on every hop.`,
                tools: [{ id: `t1`, name: `Edit`, category: `edit`, status: `completed`, target: `auth/guard.ts` }],
            },
        ]),
    );

    expect(element.textContent).toContain(`Login redirect fix`);
    expect(element.textContent).toContain(`fix the login redirect loop`);
    // Prose goes through the shared markdown engine, so emphasis is rendered rather than printed.
    expect(element.querySelector(`.chat-markdown strong`)?.textContent).toBe(`re-ran`);
    // The agent's work is drawn by the app's own tool card: the file it edited is on the page.
    expect(element.textContent).toContain(`auth/guard.ts`);
});

/* THE PAGE'S ONE SECURITY CLAIM, checked rather than asserted: a card here reaches nothing. In the app the
 * same card's path opens the workspace, its command attaches to a shell and its delegation links to a
 * transcript: every one of those is a door, and a published page has no building behind it. */
it(`leaves nothing on a tool card to click: no workspace, no shell, no links out`, () => {
    const element = publish(
        conversation([
            {
                role: `assistant`,
                text: `Done.`,
                tools: [
                    // A card whose header IS a path (no separate target), which is the one the app draws as a
                    // button into the workspace.
                    { id: `t1`, name: `Read`, category: `read`, status: `completed`, locations: [{ path: `auth/guard.ts`, line: 12 }] },
                    {
                        id: `t2`,
                        name: `Bash`,
                        category: `execute`,
                        status: `completed`,
                        target: `npm test`,
                        content: [{ type: `text`, text: `2 passed` }],
                    },
                ],
            },
        ]),
    );

    // The path is on the page: it is the record of what ran, but it is not a control.
    expect(element.textContent).toContain(`auth/guard.ts`);
    // The fold toggle is the only button a card may carry here.
    const buttons = [...element.querySelectorAll(`button`)];
    expect(buttons.every((button) => button.getAttribute(`aria-expanded`) !== null)).toBe(true);
    // And nothing navigates anywhere, in-app or out, except the one attribution link in the footer.
    const links = [...element.querySelectorAll(`a`)].map((anchor) => anchor.getAttribute(`href`));
    expect(links).toEqual([`https://intentic.dev`]);
});

it(`says what it is showing, so a messages-only share does not read as an agent that did nothing`, () => {
    const element = publish(conversation([{ role: `user`, text: `hi` }], `messages`));
    expect(element.textContent).toContain(`messages`);
    expect(element.textContent).toContain(`hi`);
});

it(`renders a page with no conversation in it as a page with nothing to show, not a broken one`, () => {
    const element = publish(null);
    expect(element.querySelector(`.chat-markdown`)).toBeNull();
    expect(element.textContent?.trim().length ?? 0).toBeGreaterThan(0);
});
