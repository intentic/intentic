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
