// @vitest-environment jsdom
//
// The card two surfaces share (the chat tab strip, the Changes panel's origin chips). Driven through the real
// component, because the rules worth pinning are the ones a caller can't see: where it lands relative to its
// anchor, that it declines to open on content that says nothing, that it drops a message that only repeats the
// title — the common case, since a one-line first message IS its own derived title — and that a prompt's
// pictures are drawn at the card's full width rather than inside its padding.
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import HoverCard from "./HoverCard.vue";

// The bytes behind a workspace path are fetched off the daemon; the card's job here is only to ask for them and
// draw what comes back, so the fetch is stubbed and the src it produces is what the test reads.
vi.mock(`../composables/chat/attachmentPreviews`, () => ({ attachmentPreview: (path: string) => `blob:${path}` }));

// The anchor a real trigger would be: show() measures event.currentTarget, so it has to be a live element.
// jsdom lays nothing out, so a placement test hands in the box the anchor would have had on screen.
const anchorEvent = (box?: { left: number; top: number; width?: number; height?: number }): MouseEvent => {
    const anchor = document.createElement(`button`);
    document.body.append(anchor);
    if (box !== undefined) {
        const { left, top, width = 100, height = 20 } = box;
        anchor.getBoundingClientRect = () => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top }) as DOMRect;
    }
    const event = new MouseEvent(`mouseenter`);
    Object.defineProperty(event, `currentTarget`, { value: anchor });
    return event;
};

const mount = async (): Promise<{
    card: { show: (event: MouseEvent, content: object) => void; hide: () => void };
    text: () => string;
    style: () => CSSStyleDeclaration;
}> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(HoverCard, { ref: `card` }) });
    const vm = app.mount(host) as unknown as { $refs: { card: { show: (event: MouseEvent, content: object) => void; hide: () => void } } };
    await nextTick();
    return {
        card: vm.$refs.card,
        text: () => document.body.textContent ?? ``,
        style: () => (document.body.querySelector(`.fixed`) as HTMLElement).style,
    };
};

it(`reveals the full title, and the first message under it`, async () => {
    const { card, text } = await mount();
    card.show(anchorEvent(), {
        label: `Landed by`,
        title: `Right-click on empty space`,
        messages: [{ text: `Clicking on empty space should allow also Close All option.` }],
    });
    await nextTick();
    expect(text()).toContain(`Landed by`);
    expect(text()).toContain(`Right-click on empty space`);
    expect(text()).toContain(`Close All option.`);

    card.hide();
    await nextTick();
    expect(text()).toBe(``);
});

// The pair the chat rail hovers on: what the conversation was for, and what it is about NOW. The title is
// derived from the first message and stops being a description of a long session hours ago, so the last prompt
// is the only line on the card that says where it has got to — and it is labelled, because two unmarked blocks
// of the user's own words don't say which end is which.
it(`shows the latest message under the first, labelled`, async () => {
    const { card, text } = await mount();
    card.show(anchorEvent(), {
        title: `Fix the tab strip`,
        messages: [{ text: `Fix the tab strip, it wraps to two rows.` }, { label: `Latest`, text: `Now make the rail scroll.` }],
    });
    await nextTick();
    expect(text()).toContain(`it wraps to two rows.`);
    expect(text()).toContain(`Latest`);
    expect(text()).toContain(`Now make the rail scroll.`);
    card.hide();
});

// Placement is the whole point of the card over a title=: it opens BESIDE its anchor, because every surface
// that raises it is a narrow column of rows (the pop-out chat's tab rail, the Changes panel's origin chips) and
// a card over/under the anchor lands on the rows the user is reading past. jsdom's viewport is 1024×768.
it(`opens to the right of an anchor in a left-hand column, hanging from its top edge`, async () => {
    const { card, style } = await mount();
    card.show(anchorEvent({ left: 40, top: 100, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().left).toBe(`168px`); // anchor's right edge (160) + the 8px gap
    expect(style().top).toBe(`100px`); // level with the anchor, not below it
    expect(style().bottom).toBe(``);
    card.hide();
});

it(`mirrors to the left for an anchor against the window's right edge`, async () => {
    const { card, style } = await mount();
    // The docked chat is the shell's right-hand column, so its tab strip has no room to its right.
    card.show(anchorEvent({ left: 900, top: 10, width: 100 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().left).toBe(`252px`); // anchor's left edge (900) − the gap − the width it took (640)
    card.hide();
});

/* THE WIDTH IS THE ROOM, which is the whole reason the card is worth opening next to a narrow column: the space
 * beside that column is the widest empty area on the screen, and a card that ignored it drew a prompt's
 * screenshot at the width of the rail it was escaping. A SHARE of the room, so the card still reads as
 * something floating over the page rather than a second page; floored at the width it always had, and capped
 * so a wide monitor gets a preview rather than a document. */
it(`takes a share of the room beside its anchor, floored and capped`, async () => {
    const { card, style } = await mount();
    // A rail against the left edge: 848px of room, four fifths of which is past the cap.
    card.show(anchorEvent({ left: 40, top: 100, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().maxWidth).toBe(`640px`);
    card.hide();

    // A middling gutter (488px): the share binds, and what it leaves over is the card's breathing room.
    card.show(anchorEvent({ left: 400, top: 100, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().maxWidth).toBe(`390px`);
    card.hide();

    // A gutter barely wide enough to open into: the floor holds it at the width it has always been.
    card.show(anchorEvent({ left: 550, top: 100, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().maxWidth).toBe(`320px`);
    card.hide();
});

it(`rises from the bottom edge for an anchor low in a full-height rail`, async () => {
    const { card, style } = await mount();
    card.show(anchorEvent({ left: 10, top: 700, width: 100 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().left).toBe(`118px`);
    expect(style().bottom).toBe(`48px`); // 768 − the anchor's bottom edge (720)
    expect(style().top).toBe(``);
    card.hide();
});

it(`drops a message that only repeats the title, and stays shut with nothing to say`, async () => {
    const { card, text } = await mount();
    card.show(anchorEvent(), { title: `Fix the tab strip`, messages: [{ text: `  Fix the tab strip ` }] });
    await nextTick();
    expect(text()).toBe(`Fix the tab strip`);

    card.hide();
    card.show(anchorEvent(), { label: `Landed by`, title: undefined, messages: [{ text: `   ` }] });
    await nextTick();
    expect(text()).toBe(``); // a fresh "New agent" tab has no title and no message — no empty card either
});

/* THE PICTURES A PROMPT CAME WITH, drawn edge to edge. A screenshot is often the whole of what was asked, and at
 * 320px a card that also paid its own padding out of the image would be showing a thumbnail of a thumbnail — so
 * the row breaks back out through the padding it sits in.
 *
 * A message whose words merely repeat the title keeps its block here rather than being dropped with them: the
 * duplicate line goes, the picture is not a duplicate of anything. */
it(`draws a prompt's images at the card's full width, past its padding`, async () => {
    const { card, text } = await mount();
    card.show(anchorEvent(), {
        title: `Fix the tab strip`,
        messages: [{ text: `Fix the tab strip`, attachments: [{ name: `shot.png`, path: `.intentic/records/artifacts/attachments/u1/shot.png` }] }],
    });
    await nextTick();
    const image = document.body.querySelector(`img`)!;
    expect(image.getAttribute(`src`)).toBe(`blob:.intentic/records/artifacts/attachments/u1/shot.png`);
    expect(image.className).toContain(`w-full`);
    expect(image.parentElement?.className).toContain(`-mx-3`);
    expect(text()).toBe(`Fix the tab strip`); // the repeated line still goes; only the picture is new
    card.hide();
});

/* A PICTURE IS NEVER CUT, and never sized by arithmetic. It used to be `object-cover` from the top under a
 * computed ceiling, which on the common case — a portrait capture of one panel, subject in the lower half —
 * kept the empty canvas above the subject and threw away the subject.
 *
 * So there is no height on the picture at all now: the card is a flex column, the words hold their lines, and
 * the picture takes what is left and shrinks into it. That is the whole rule, and jsdom lays nothing out, so
 * what is pinned here is the arrangement that produces it — including `min-h-0`, without which a replaced
 * element refuses to shrink and gets clipped by the card's edge instead, which is the old bug in a new place. */
it(`draws a picture whole, sized by the room the card has left`, async () => {
    const { card, style } = await mount();
    const image = (): HTMLElement => document.body.querySelector(`img`) as HTMLElement;
    const content = { title: `Fix the tab strip`, messages: [{ attachments: [{ name: `shot.png`, path: `a/shot.png` }] }] };

    card.show(anchorEvent({ left: 40, top: 100, width: 120 }), content);
    await nextTick();
    expect(style().maxHeight).toBe(`660px`); // the card still stops at the room its corner leaves
    expect(image().style.maxHeight).toBe(``); // ...and the picture inside it is given no height of its own
    expect(image().className).toContain(`object-contain`); // no crop, at any card size
    expect(image().className).toContain(`min-h-0`); // it yields to the words rather than being clipped
    expect(document.body.querySelector(`.fixed`)?.className).toContain(`flex-col`);
    card.hide();
});

// The send-time object URL wins where the page still has one — the same picture the sent bubble is showing,
// without a second trip to the daemon for bytes this browser already holds.
it(`prefers an attachment's own preview url over refetching it`, async () => {
    const { card } = await mount();
    card.show(anchorEvent(), {
        title: `Look at this`,
        messages: [{ attachments: [{ name: `shot.png`, path: `a/shot.png`, previewUrl: `blob:local-object-url` }] }],
    });
    await nextTick();
    expect(document.body.querySelector(`img`)?.getAttribute(`src`)).toBe(`blob:local-object-url`);
    card.hide();
});

/* A card may not grow past the edge it was placed against. Text clamps itself to a known number of lines; an
 * image is however tall the user's screenshot was, so without a cap a two-screenshot hover near the bottom of a
 * rail runs off the window — and nothing can scroll a card the pointer passes straight through. */
it(`caps its height at the room its corner leaves`, async () => {
    const { card, style } = await mount();
    card.show(anchorEvent({ left: 40, top: 600, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().bottom).toBe(`148px`); // rises from the anchor's bottom edge (620)
    expect(style().maxHeight).toBe(`612px`); // ...and reaches no further than the window's top margin
    card.hide();

    card.show(anchorEvent({ left: 40, top: 100, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().top).toBe(`100px`); // hangs from the anchor's top edge
    expect(style().maxHeight).toBe(`660px`); // 768 − 100 − the 8px margin
    card.hide();
});
