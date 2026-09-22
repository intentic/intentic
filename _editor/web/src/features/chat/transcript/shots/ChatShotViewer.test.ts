// The conversation's one viewer: where it opens, how the keys and the filmstrip move it, what its caption says, and
// that Open in workspace hands the file to the surface. The kit's box is stood in by one that draws its slot while open.
import "@intentic/testing/dom";
import { describe, it, expect, afterEach, beforeEach, mock } from "bun:test";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { STATE_DIR } from "@intentic/constants";
import * as actualUi from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";
import { CHAT_SURFACE } from "../../tools/chatToolSurface";
import { type ChatShot, shotKey } from "./shots";

// Snapshotted before the mock replaces the module: a namespace is a live binding.
const realUi = { ...actualUi };
mock.module("@intentic/ui", () => ({
    ...realUi,
    Modal: defineComponent({
        name: `Modal`,
        props: { open: Boolean },
        emits: [`update:open`, `show`],
        setup: (props, { slots }) => () => (props.open ? h(`div`, { "data-modal": `` }, slots[`default`]?.()) : null),
    }),
}));

// What the file cache answers per path; a path it doesn't hold is gone.
const files = new Map<string, string>();
mock.module("./shotPictures", () => ({
    pictureAt: (_agent: string | undefined, path: string) => ({ url: files.get(path) }),
    tileOf: (_agent: string | undefined, path: string) => ({ url: files.get(path) }),
}));

const { default: ChatShotViewer } = await import("./ChatShotViewer.vue");

const SHOTS = `${STATE_DIR}/records/artifacts/browser`;

const shotAt = (turnId: number, name: string): ChatShot => {
    const path = `${SHOTS}/${name}.png`;
    return { key: shotKey(name, path), path, toolId: name, turnId };
};

// Two turns: two pictures from the first prompt, one from the second.
const SHOTS_OF_CHAT = [shotAt(1, `before`), shotAt(1, `after`), shotAt(7, `dark`)];
const PROMPTS = new Map([
    [1, `Fix the header`],
    [7, `Now the dark theme`],
]);

let app: App | undefined;
const openFile = mock<(path: string) => void>();
const open = ref(true);

const mount = (start: string | undefined): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    open.value = true;
    app = createApp({
        render: () =>
            h(ChatShotViewer, {
                open: open.value,
                "onUpdate:open": (value: boolean) => (open.value = value),
                shots: SHOTS_OF_CHAT,
                start,
                agent: undefined,
                prompts: PROMPTS,
            }),
    });
    app.provide(CHAT_SURFACE, { imageUrl: () => undefined, openFile });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

const title = (element: HTMLElement): string | undefined => element.querySelector(`h2`)?.textContent?.trim();
const caption = (element: HTMLElement): string | undefined => element.querySelector(`header p`)?.textContent?.replace(/\s+/g, ` `).trim();
const press = async (element: HTMLElement, key: string): Promise<void> => {
    element.querySelector(`[tabindex="-1"]`)?.dispatchEvent(new KeyboardEvent(`keydown`, { key, bubbles: true }));
    await nextTick();
};

beforeEach(() => {
    openFile.mockClear();
    files.clear();
    for (const shot of SHOTS_OF_CHAT) {
        files.set(shot.path, `blob:${shot.path}`);
    }
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

describe(`ChatShotViewer`, () => {
    it(`opens at the shot it was asked for, captioned with its name, its place and what its turn was asked`, () => {
        const element = mount(SHOTS_OF_CHAT[1]!.key);
        expect(title(element)).toBe(`after`);
        expect(caption(element)).toBe(`2 of 3 · Fix the header`);
        expect(element.querySelector(`img[alt="after"]`)?.getAttribute(`src`)).toBe(`blob:${SHOTS}/after.png`);
    });

    it(`opens at the first shot when the one it was asked for is no longer in the list`, () => {
        expect(title(mount(`gone\nnowhere.png`))).toBe(`before`);
    });

    it(`walks the conversation with the arrows, Home and End, and holds at either end`, async () => {
        const element = mount(SHOTS_OF_CHAT[0]!.key);
        await press(element, `ArrowLeft`);
        expect(title(element)).toBe(`before`);
        await press(element, `ArrowRight`);
        await press(element, `ArrowRight`);
        expect(caption(element)).toBe(`3 of 3 · Now the dark theme`);
        await press(element, `ArrowRight`);
        expect(title(element)).toBe(`dark`);
        await press(element, `Home`);
        expect(title(element)).toBe(`before`);
        await press(element, `End`);
        expect(title(element)).toBe(`dark`);
    });

    it(`groups the filmstrip by turn, marks where it stands, and jumps on a press`, async () => {
        const element = mount(SHOTS_OF_CHAT[0]!.key);
        const strip = element.querySelector(`nav`)!;
        expect([...strip.querySelectorAll(`div`)].map((group) => group.querySelectorAll(`button`).length)).toEqual([2, 1]);
        const thumbs = [...strip.querySelectorAll<HTMLButtonElement>(`button`)];
        expect(thumbs.map((thumb) => thumb.getAttribute(`aria-current`))).toEqual([`true`, `false`, `false`]);
        thumbs[2]?.click();
        await nextTick();
        expect(title(element)).toBe(`dark`);
        expect([...strip.querySelectorAll(`button`)].map((thumb) => thumb.getAttribute(`aria-current`))).toEqual([`false`, `false`, `true`]);
    });

    it(`hands Open in workspace to the surface and closes`, async () => {
        const element = mount(SHOTS_OF_CHAT[2]!.key);
        element.querySelector<HTMLButtonElement>(`button[aria-label="Open in workspace"]`)?.click();
        await nextTick();
        expect(openFile.mock.calls).toEqual([[`${SHOTS}/dark.png`]]);
        expect(open.value).toBe(false);
    });

    it(`says a picture with nothing on disk is no longer available`, () => {
        files.delete(SHOTS_OF_CHAT[0]!.path);
        const element = mount(SHOTS_OF_CHAT[0]!.key);
        expect(element.querySelector(`img[alt="before"]`)).toBeNull();
        expect(element.textContent).toContain(`No longer available`);
    });
});
