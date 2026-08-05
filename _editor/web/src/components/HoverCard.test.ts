// @vitest-environment jsdom
//
// The card two surfaces share (the chat tab strip, the Changes panel's origin chips). Driven through the real
// component, because the rules worth pinning are the ones a caller can't see: where it lands relative to its
// anchor, that it declines to open on content that says nothing, and that it drops a body that only repeats the
// title — the common case, since a one-line first message IS its own derived title.
import { expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import HoverCard from "./HoverCard.vue";

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
        body: `Clicking on empty space should allow also Close All option.`,
    });
    await nextTick();
    expect(text()).toContain(`Landed by`);
    expect(text()).toContain(`Right-click on empty space`);
    expect(text()).toContain(`Close All option.`);

    card.hide();
    await nextTick();
    expect(text()).toBe(``);
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
    expect(style().left).toBe(`572px`); // anchor's left edge (900) − the gap − the card's 320px width
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

it(`drops a body that only repeats the title, and stays shut with nothing to say`, async () => {
    const { card, text } = await mount();
    card.show(anchorEvent(), { title: `Fix the tab strip`, body: `  Fix the tab strip ` });
    await nextTick();
    expect(text()).toBe(`Fix the tab strip`);

    card.hide();
    card.show(anchorEvent(), { label: `Landed by`, title: undefined, body: `   ` });
    await nextTick();
    expect(text()).toBe(``); // a fresh "New agent" tab has no title and no message — no empty card either
});
