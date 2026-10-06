// A transcript's wait is one of two things: its turns outlined (as they last stood, or hand-drawn bars before that), or,
// for a host that asked for a quiet wait (/agents/:id), a single line and nothing to tear down when the turns land.
import "@intentic/testing/dom";
import { type App, createApp, h, nextTick } from "vue";
import { IconStub } from "@intentic/ui/testing";

const { default: ChatTranscriptSkeleton } = await import("./ChatTranscriptSkeleton.vue");

let app: App | undefined;

const mount = async (of: string | undefined): Promise<HTMLElement> => {
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({ render: () => h(ChatTranscriptSkeleton, of === undefined ? {} : { of }) });
    app.component(`Icon`, IconStub);
    app.mount(el);
    await nextTick();
    return el;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`outlines the turns to come for a host that keeps the outline`, async () => {
    const el = await mount(`chat.transcript:never-seen`);

    expect(el.querySelector(`[role="status"]`)?.getAttribute(`aria-busy`)).toBe(`true`);
    expect(el.querySelectorAll(`.chat-surface`).length).toBeGreaterThan(1);
});

it(`says one line and draws no turns for a quiet wait`, async () => {
    const el = await mount(undefined);

    const status = el.querySelector(`[role="status"]`)!;
    expect(status.getAttribute(`aria-busy`)).toBe(`true`);
    expect(status.querySelectorAll(`.chat-surface, .chat-surface-assistant`)).toHaveLength(0);
    // Said where it can be read, not only to a screen reader: nothing else on screen tells the wait apart from an empty chat.
    const line = [...status.querySelectorAll(`p`)].find((p) => p.textContent?.includes(`Loading conversation…`));
    expect(line).toBeDefined();
    expect(status.querySelector(`.sr-only`)).toBeNull();
});
