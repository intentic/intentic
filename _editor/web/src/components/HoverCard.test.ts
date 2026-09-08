// @vitest-environment jsdom
// The card two surfaces share (the chat tab strip, the Changes panel's origin chips), driven through the real
// component since the rules worth pinning are invisible to a caller: placement relative to the anchor, declining
// to open on content that says nothing, dropping a message that only repeats the title, and drawing a prompt's
// pictures at the card's full width rather than inside its padding.
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick } from "vue";
import HoverCard from "./HoverCard.vue";

// The card only asks for a path's bytes and draws what comes back; the fetch is stubbed so its produced `src` is
// what the test reads.
vi.mock(`../features/chat/drafts/attachmentPreviews`, () => ({ attachmentPreview: (path: string) => `blob:${path}` }));

// show() measures `event.currentTarget`, so the anchor must be a live element; since jsdom lays nothing out, a
// placement test hands in the box the anchor would have had.
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

// What the conversation was for, and what it's about now: the title (derived from the first message) stops
// describing a long session, so the latest prompt is labelled, since two unmarked blocks of the user's words
// don't say which end is which.
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

// Opens beside the anchor, not over/under it, since every surface raising this card is a narrow column of rows a
// vertical placement would cover. jsdom's viewport is 1024×768.
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

// The room beside a narrow column is the widest empty area on the screen, so the card takes a share of it rather
// than its old fixed width; floored at the width it always had, capped so a wide monitor gets a preview, not a
// document.
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

// A prompt's pictures draw edge to edge, past the card's own padding, since paying padding out of a small image
// would shrink it to a thumbnail of a thumbnail. A message whose words repeat the title still keeps its block if
// it carries a picture; only the duplicate line is dropped.
it(`draws a prompt's images at the card's full width, past its padding`, async () => {
    const { card, text } = await mount();
    card.show(anchorEvent(), {
        title: `Fix the tab strip`,
        messages: [{ text: `Fix the tab strip`, attachments: [`.intentic/records/artifacts/attachments/u1/shot.png`] }],
    });
    await nextTick();
    const image = document.body.querySelector(`img`)!;
    expect(image.getAttribute(`src`)).toBe(`blob:.intentic/records/artifacts/attachments/u1/shot.png`);
    expect(image.className).toContain(`w-full`);
    expect(image.parentElement?.className).toContain(`-mx-3`);
    expect(text()).toBe(`Fix the tab strip`); // the duplicate line still drops; only the picture is new.
    card.hide();
});

// A picture is never cropped or sized by arithmetic: the card is a flex column, the words keep their lines, and
// the picture takes whatever room is left and shrinks into it. Since jsdom lays nothing out, this pins the
// arrangement that produces that, including `min-h-0`, without which a replaced element refuses to shrink and
// gets clipped by the card's edge instead.
it(`draws a picture whole, sized by the room the card has left`, async () => {
    const { card, style } = await mount();
    const image = (): HTMLElement => document.body.querySelector(`img`) as HTMLElement;
    const content = { title: `Fix the tab strip`, messages: [{ attachments: [`a/shot.png`] }] };

    card.show(anchorEvent({ left: 40, top: 100, width: 120 }), content);
    await nextTick();
    expect(style().maxHeight).toBe(`660px`); // the card still stops at the room its corner leaves
    expect(image().style.maxHeight).toBe(``); // the picture inside it is given no height of its own.
    expect(image().className).toContain(`object-contain`); // no crop, at any card size
    expect(image().className).toContain(`min-h-0`); // it yields to the words rather than being clipped
    expect(document.body.querySelector(`.fixed`)?.className).toContain(`flex-col`);
    card.hide();
});

// The thumb comes from the path alone, since the daemon's record and the run's frame log carry a path and name
// but no object URL. One lookup, so every surface showing these bytes agrees.
it(`draws an attachment's thumb from its path`, async () => {
    const { card } = await mount();
    card.show(anchorEvent(), {
        title: `Look at this`,
        messages: [{ attachments: [`a/shot.png`] }],
    });
    await nextTick();
    expect(document.body.querySelector(`img`)?.getAttribute(`src`)).toBe(`blob:a/shot.png`);
    card.hide();
});

// A card can't grow past the edge it's placed against: text clamps to a fixed number of lines, but an image is as
// tall as the screenshot was, and nothing can scroll a card the pointer passes through.
it(`caps its height at the room its corner leaves`, async () => {
    const { card, style } = await mount();
    card.show(anchorEvent({ left: 40, top: 600, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().bottom).toBe(`148px`); // rises from the anchor's bottom edge (620)
    expect(style().maxHeight).toBe(`612px`); // reaches no further than the window's top margin.
    card.hide();

    card.show(anchorEvent({ left: 40, top: 100, width: 120 }), { title: `Fix the tab strip` });
    await nextTick();
    expect(style().top).toBe(`100px`); // hangs from the anchor's top edge
    expect(style().maxHeight).toBe(`660px`); // 768 − 100 − the 8px margin
    card.hide();
});

// An anchor can be removed while the card is up, the one case a surface's own `@mouseleave` never catches (a
// removed element fires no leave event). Both callers can do this without the pointer moving (a tab closed by its
// own ✕, a change row refreshed away under an agent's write), leaving a `pointer-events-none` card floating with
// nothing to click it away.
it(`stops showing once its anchor has been taken off the page`, async () => {
    const { card, text } = await mount();
    const event = anchorEvent();
    const anchor = event.currentTarget as HTMLElement;
    card.show(event, { title: `Right-click on empty space` });
    await nextTick();
    expect(text()).toContain(`Right-click on empty space`);

    anchor.remove();
    // The next thing the pointer does anywhere on the page, which is the first moment anyone could notice.
    document.dispatchEvent(new MouseEvent(`pointermove`));
    await nextTick();
    expect(text()).not.toContain(`Right-click on empty space`);
});
