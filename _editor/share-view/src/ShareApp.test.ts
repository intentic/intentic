// @vitest-environment jsdom
// jsdom, since every claim here is about what the published page renders — including what it does not render.
// This is the one surface an outsider touches, so "nothing here reaches back into the workspace" is checked
// against real output, not the source.
import type { TranscriptRow, SharePayload } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp } from "vue";
import { IconStub } from "@intentic/ui/testing";

// jsdom has no matchMedia, which useDevice reads at import time; hoisted so it runs before the imports evaluate.
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
    // Stubs keep the test off the real icon collections (28 KB of data irrelevant to what's asserted).
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const conversation = (messages: readonly TranscriptRow[], detail: SharePayload["detail"] = `everything`): SharePayload => ({
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

// The page's one security claim, checked rather than asserted: in the app the same card's path opens the
// workspace, its command attaches to a shell; here none of those doors exist.
it(`leaves nothing on a tool card to click: no workspace, no shell, no links out`, () => {
    const element = publish(
        conversation([
            {
                role: `assistant`,
                text: `Done.`,
                tools: [
                    // A card whose header is a path (no separate target) — the one the app draws as a workspace button.
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
    // Nothing navigates anywhere except the one attribution link in the footer.
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
