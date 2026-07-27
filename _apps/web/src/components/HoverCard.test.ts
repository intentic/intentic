// @vitest-environment jsdom
//
// The card two surfaces share (the chat tab strip, the Changes panel's origin chips). Driven through the real
// component, because the rules worth pinning are the ones a caller can't see: it declines to open on content
// that says nothing, and it drops a body that only repeats the title — the common case, since a one-line first
// message IS its own derived title.
import { expect, it } from "vitest";
import { createApp, h, nextTick } from "vue";
import HoverCard from "./HoverCard.vue";

// The anchor a real trigger would be: show() measures event.currentTarget, so it has to be a live element.
const anchorEvent = (): MouseEvent => {
    const anchor = document.createElement(`button`);
    document.body.append(anchor);
    const event = new MouseEvent(`mouseenter`);
    Object.defineProperty(event, `currentTarget`, { value: anchor });
    return event;
};

const mount = async (): Promise<{ card: { show: (event: MouseEvent, content: object) => void; hide: () => void }; text: () => string }> => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({ render: () => h(HoverCard, { ref: `card` }) });
    const vm = app.mount(host) as unknown as { $refs: { card: { show: (event: MouseEvent, content: object) => void; hide: () => void } } };
    await nextTick();
    return { card: vm.$refs.card, text: () => document.body.textContent ?? `` };
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
