// What a sent prompt's attachments are drawn AS. The rule under test is one line: a bubble is what the user said, and
// what they brought with it is not one — so nothing in this row may wear the prompt's own surface.
import "@intentic/testing/dom";
import { type App, createApp, h } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { IconStub } from "@intentic/ui/testing";
import { CHAT_SURFACE } from "../tools/chatToolSurface";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import ChatAttachmentStrip from "./ChatAttachmentStrip.vue";

jest.mock("../drafts/attachmentQuickLooks", () => ({
    attachmentQuickLook: () => ({
        present: true,
        size: 2_400_000,
        head: `21:26:45 INFO  starting setup`,
        headBytes: 8_192,
        tailBytes: 0,
        binary: false,
    }),
}));

let app: App | undefined;

const mount = (
    attachments: readonly (Pick<PendingAttachment, `name` | `path`> & Partial<PendingAttachment>)[],
    props: Record<string, unknown> = {},
): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({ render: () => h(ChatAttachmentStrip, { attachments, ...props }) });
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

// Everything not a picture and not a sound keeps the text look; the audio branch must not swallow the rest.
it("leaves a log to the file chip's own lead lines", () => {
    const element = mount([{ name: `desktop-setup.log`, path: `${STATE_DIR}/x/desktop-setup.log` }]);

    expect(element.querySelector(`audio`)).toBeNull();
    expect(element.textContent).toContain(`starting setup`);
});

// The composer's row: a picture still going up is a chip naming it, framed and removable, not the sent bubble's bare thumbnail.
it("stages a picture as a removable chip that names it, and hands the press back with the attachment", () => {
    const staged = {
        id: `u1`,
        name: `shot.png`,
        path: `${STATE_DIR}/x/shot.png`,
        previewUrl: `blob:shot`,
        status: `uploading` as const,
        progress: 0.5,
    };
    const remove = jest.fn();
    const element = mount([staged], { staged: true, onRemove: remove });

    expect(element.textContent).toContain(`shot.png`);
    element.querySelector<HTMLButtonElement>(`button[aria-label="Remove attachment"]`)?.click();
    expect(remove).toHaveBeenCalledWith(staged);
});
