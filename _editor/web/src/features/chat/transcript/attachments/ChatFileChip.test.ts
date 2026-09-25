// The chip a non-picture attachment is drawn as, and the card it opens. Pins what the old name-only chip withheld:
// which file this is (its ending, not just its beginning), how big, and what is actually in it.
import "@intentic/testing/dom";
import { type App, createApp, h } from "vue";
import { STATE_DIR } from "@intentic/constants";
import { IconStub } from "@intentic/ui/testing";
import { CHAT_SURFACE, type ChatSurface } from "../../tools/chatToolSurface";
import type { FileQuickLook } from "../../drafts/fileQuickLook";
import ChatFileChip from "./ChatFileChip.vue";

const openFile = jest.fn();

// A 2.4 MB log: the case the screenshot was of, where head and tail are both quoted and the middle is not.
const LOG: FileQuickLook = {
    present: true,
    size: 2_400_000,
    head: `21:26:45 INFO  starting setup\n21:26:46 WARN  folder sync retry 1/5`,
    headBytes: 8_192,
    tail: `21:41:02 ERROR sync never settled`,
    tailBytes: 8_192,
    binary: false,
};

let app: App | undefined;

const mount = (props: Record<string, unknown> = {}, surface: ChatSurface = { imageUrl: () => undefined, openFile }): HTMLElement => {
    const element = document.createElement(`div`);
    document.body.append(element);
    app = createApp({
        render: () =>
            h(ChatFileChip, { name: `desktop-setup-20260912-212645.log`, path: `${STATE_DIR}/x/desktop-setup-20260912-212645.log`, ...props }),
    });
    app.provide(CHAT_SURFACE, surface);
    app.component(`Icon`, IconStub);
    app.directive(`tooltip`, {});
    app.mount(element);
    return element;
};

beforeEach(() => {
    openFile.mockClear();
    // jsdom measures every box as 0×0, which AnchoredOverlay reads as an anchor that has gone away and closes over.
    jest.spyOn(HTMLElement.prototype, `getBoundingClientRect`).mockReturnValue({
        top: 100,
        left: 600,
        width: 200,
        height: 40,
        right: 800,
        bottom: 140,
        x: 600,
        y: 100,
        toJSON: () => ({}),
    } as DOMRect);
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
    jest.restoreAllMocks();
});

// A trailing truncation eats the timestamp, which is the only part telling this log from the previous run's.
it("keeps the end of the name, which is what tells two attachments apart", () => {
    const text = mount({ look: LOG }).textContent ?? ``;
    expect(text).toContain(`desktop-setup-20260912-212645.log`);
    // Two runs: the first is what a narrow tile clips, the second is the ending, which is never given up.
    const drawn = [...document.querySelectorAll(`span`)].find((span) => span.textContent === `desktop-setup-20260912-212645.log`);
    expect(drawn?.children).toHaveLength(2);
    expect(drawn?.children[0]?.textContent).toBe(`desktop-setup-20260912-2`);
    expect(drawn?.children[1]?.textContent).toBe(`12645.log`);
});

it("states the scale a filename withholds, and not the kind it already carries", () => {
    const text = mount({ look: LOG }).textContent ?? ``;
    expect(text).toContain(`2.3 MB`);
    expect(text).not.toContain(`LOG`);
});

// The head window is clipped, so the file's own line count isn't known and must not be guessed at.
it("claims a line count only for a file it has all of", () => {
    expect(mount({ look: LOG }).textContent).not.toContain(`lines`);

    app?.unmount();
    document.body.innerHTML = ``;
    const whole = mount({ look: { ...LOG, size: 64, headBytes: 64, tail: undefined, tailBytes: 0 } });
    expect(whole.textContent).toContain(`2 lines`);
});

it("draws the file's own first lines, the text equivalent of a thumbnail", () => {
    const text = mount({ look: LOG, lead: 2 }).textContent ?? ``;
    expect(text).toContain(`21:26:45 INFO  starting setup`);
    expect(text).toContain(`21:26:46 WARN  folder sync retry 1/5`);
});

// The screenshot beside it is a bare picture in a hairline: its own pixels framed, no chrome around them. A file gets
// the same deal — the box belongs to the file's text, and the naming sits outside it on the transcript.
it("frames the file's text and nothing else", () => {
    const boxes = mount({ look: LOG, lead: 2 }).querySelectorAll(`.border-line`);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.textContent).toContain(`21:26:45 INFO  starting setup`);
    expect(boxes[0]?.textContent).not.toContain(`desktop-setup`);
});

// One row of them over the input is the one place a border earns itself: each has to read as a separate thing you can
// take back out, which a bare caption next to another bare caption does not.
it("keeps a border in the composer, where a chip is a token", () => {
    const element = mount({ look: LOG, framed: true });
    expect(element.firstElementChild?.className).toContain(`border-line`);
    expect(element.querySelectorAll(`.border-line`)).toHaveLength(1);
});

// The face is three lines of a file that has thousands; ending them on a hard edge would claim that is the file.
it("fades the drawn lines only where the file runs past them", () => {
    expect(mount({ look: LOG, lead: 2 }).querySelector(`[class*="mask-b"]`)).not.toBeNull();

    app?.unmount();
    document.body.innerHTML = ``;
    // Head window reached the end, and every line it holds is drawn: there is no more of this file to promise.
    const whole = mount({ look: { ...LOG, size: 64, headBytes: 64, tail: undefined, tailBytes: 0 }, lead: 3 });
    expect(whole.querySelector(`[class*="mask-b"]`)).toBeNull();
});

it("opens the real file in the workspace when pressed", () => {
    const element = mount({ look: LOG });
    element.querySelector(`button`)?.click();
    expect(openFile).toHaveBeenCalledWith(`${STATE_DIR}/x/desktop-setup-20260912-212645.log`);
});

// A published page has no workspace behind it: the chip still names the file, but nothing offers to open it.
it("is not a control on a surface with nothing to open", () => {
    const element = mount({ look: LOG }, { imageUrl: () => undefined });
    expect(element.querySelector(`button`)).toBeNull();
    expect(element.textContent).toContain(`desktop-setup-20260912-212645.log`);
});

it("shows the head, the tail, and says the middle is missing", async () => {
    mount({ look: LOG });
    document.querySelector(`button`)?.dispatchEvent(new FocusEvent(`focus`));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const card = document.querySelector(`.ui-anchored`)?.textContent ?? ``;
    expect(card).toContain(`21:26:45 INFO  starting setup`);
    expect(card).toContain(`21:41:02 ERROR sync never settled`);
    // The gap between the two halves is stated, never a silent join.
    expect(card).toContain(`not shown`);
});

it("says what a file is instead of a preview it can't give", async () => {
    mount({ look: { present: true, size: 900_000, head: ``, headBytes: 8_192, tailBytes: 0, binary: true } });
    document.querySelector(`button`)?.dispatchEvent(new FocusEvent(`focus`));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector(`.ui-anchored`)?.textContent).toContain(`Not text`);
});

// placeAnchored trades a side only for its opposite, so a card wanting the left of a chip with no room either side
// would be placed at a negative x and cut off. Narrow windows and popped-out panels are exactly that case.
it("drops the card under the chip when neither side of it has room", async () => {
    jest.spyOn(HTMLElement.prototype, `getBoundingClientRect`).mockReturnValue({
        top: 100,
        left: 300,
        width: 200,
        height: 40,
        right: 500,
        bottom: 140,
        x: 300,
        y: 100,
        toJSON: () => ({}),
    } as DOMRect);
    mount({ look: LOG });
    document.querySelector(`button`)?.dispatchEvent(new FocusEvent(`focus`));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector(`.ui-anchored`)?.className).toContain(`ui-anchored-bottom`);
});

// Nothing to draw yet means nothing to open: a card that appeared empty and filled in later would flash on every hover.
it("opens no card before the bytes land", async () => {
    mount();
    document.querySelector(`button`)?.dispatchEvent(new FocusEvent(`focus`));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector(`.ui-anchored`)).toBeNull();
});
