// @vitest-environment jsdom
// What a sent prompt's attachments are drawn AS. The rule under test is one line: a bubble is what the user said, and
// what they brought with it is not one — so nothing in this row may wear the prompt's own surface.
import { afterEach, expect, it, vi } from "vitest";
import { type App, createApp, h } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { IconStub } from "@intentic/ui/testing";
import { CHAT_SURFACE } from "../tools/chatToolSurface";
import ChatAttachmentStrip from "./ChatAttachmentStrip.vue";

vi.mock("../drafts/attachmentPeeks", () => ({
    attachmentPeek: () => ({
        present: true,
        size: 2_400_000,
        head: `21:26:45 INFO  starting setup`,
        headBytes: 8_192,
        tailBytes: 0,
        binary: false,
    }),
}));

let app: App | undefined;

const mount = (attachments: readonly { name: string; path: string; previewUrl?: string }[]): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatAttachmentStrip, { attachments }) });
    app.provide(CHAT_SURFACE, { imageUrl: () => undefined, openFile: () => undefined });
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it("never paints an attachment with the prompt bubble's surface", () => {
    const element = mount([
        { name: `shot.png`, path: `${STATE_DIR}/x/shot.png`, previewUrl: `blob:shot` },
        { name: `desktop-setup.log`, path: `${STATE_DIR}/x/desktop-setup.log` },
    ]);
    expect(element.querySelector(`.chat-surface`)).toBeNull();
    expect(element.textContent).toContain(`desktop-setup.log`);
    // The empty box in the original report: a one-line chip stretched to the 56px thumbnail beside it by a flex row
    // with no cross-axis rule, and read as a panel someone forgot to fill.
    expect(element.firstElementChild?.className).toContain(`items-start`);
});

// A sound sent is the same sound staged: the bubble has to keep the player, or pressing send turns a thing you can
// hear back into a filename and a byte count.
it("keeps a sent sound playable instead of naming it", () => {
    const element = mount([{ name: `voice-note.m4a`, path: `${STATE_DIR}/x/voice-note.m4a` }]);

    const seek = element.querySelector(`[role="slider"]`);
    expect(seek?.getAttribute(`aria-label`)).toBe(`Seek voice-note.m4a`);
    expect(element.querySelector(`audio`)).not.toBeNull();
    expect(element.querySelector(`button[aria-label="Play voice-note.m4a"]`)).not.toBeNull();
});

// Everything not a picture and not a sound keeps the text peek; the audio branch must not swallow the rest.
it("leaves a log to the file chip's own lead lines", () => {
    const element = mount([{ name: `desktop-setup.log`, path: `${STATE_DIR}/x/desktop-setup.log` }]);

    expect(element.querySelector(`audio`)).toBeNull();
    expect(element.textContent).toContain(`starting setup`);
});
