// `v-tooltip`'s two shapes, pinned here since @intentic/ui has no test runner of its own: a string is a label, a `Tip`
// is a card of headline, figures and key cap, and neither can put markup on screen.
import "@intentic/testing/dom";
import { createApp, h, nextTick, ref, withDirectives } from "vue";
import { type TooltipValue, vTooltip } from "@intentic/ui";

const anchored = (value: TooltipValue) => {
    const held = ref<TooltipValue>(value);
    const tick = ref(0);
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({
        // `tick` re-renders the owner without changing what the tooltip says, as a streaming panel does.
        render: () => withDirectives(h(`button`, { class: `anchor`, "data-tick": tick.value }, `go`), [[vTooltip, held.value]]),
    });
    app.mount(host);
    const anchor = host.querySelector<HTMLElement>(`.anchor`)!;
    const done = (): void => {
        app.unmount();
        host.remove();
    };
    return { anchor, held, tick, done };
};

const box = (): HTMLElement | null => document.body.querySelector<HTMLElement>(`.ui-tooltip`);
const hover = (el: HTMLElement): void => {
    el.dispatchEvent(new MouseEvent(`mouseenter`));
};

it(`draws a string as a plain label`, () => {
    const { anchor, done } = anchored(`Archive`);
    hover(anchor);
    expect(box()?.textContent).toBe(`Archive`);
    expect(box()?.classList.contains(`ui-tooltip-card`)).toBe(false);
    done();
    expect(box()).toBeNull();
});

it(`draws a tip as a card of headline, key cap, figures and note`, () => {
    const { anchor, done } = anchored({
        title: `Memory low`,
        tone: `warn`,
        keys: `Shift+Enter`,
        rows: [
            { label: `Resident`, value: `7.4 GiB` },
            { label: `Swap`, value: `4.1 GiB`, tone: `danger` },
            { label: `Empty`, value: `` },
        ],
        note: `Frees on idle`,
    });
    hover(anchor);
    const card = box()!;
    expect(card.classList.contains(`ui-tooltip-card`)).toBe(true);
    expect(card.querySelector(`.ui-tip-title`)?.textContent).toBe(`Memory low`);
    expect(card.querySelector<HTMLElement>(`.ui-tip-dot`)?.dataset[`tone`]).toBe(`warn`);
    expect(card.querySelector(`kbd`)?.textContent).toBe(`Shift+Enter`);
    // A row with nothing to say is dropped rather than drawn as a dangling label.
    expect([...card.querySelectorAll(`dt`)].map((dt) => dt.textContent)).toEqual([`Resident`, `Swap`]);
    expect([...card.querySelectorAll(`dd`)].map((dd) => dd.textContent)).toEqual([`7.4 GiB`, `4.1 GiB`]);
    expect(card.querySelectorAll(`dd`)[1]?.getAttribute(`data-tone`)).toBe(`danger`);
    expect(card.querySelector(`.ui-tip-note`)?.textContent).toBe(`Frees on idle`);
    done();
});

it(`never renders a tip's words as markup`, () => {
    const { anchor, done } = anchored({ title: `<b>bold</b>`, rows: [{ label: `<i>x</i>`, value: 3 }] });
    hover(anchor);
    expect(box()?.querySelector(`b, i`)).toBeNull();
    expect(box()?.querySelector(`.ui-tip-title`)?.textContent).toBe(`<b>bold</b>`);
    done();
});

it(`raises nothing for an empty label or a tip with no headline`, () => {
    const blanks: readonly TooltipValue[] = [``, `   `, undefined, null, false, { title: `` }];
    for (const value of blanks) {
        const { anchor, done } = anchored(value);
        hover(anchor);
        expect(box()).toBeNull();
        done();
    }
});

// A template builds a fresh object literal on every render; an equal tip must not rebuild the box it is holding open.
it(`keeps an open card through a re-render that says the same thing`, async () => {
    const { anchor, tick, held, done } = anchored({ title: `Queued`, rows: [{ label: `Ahead`, value: 2 }] });
    hover(anchor);
    const first = box();
    held.value = { title: `Queued`, rows: [{ label: `Ahead`, value: 2 }] };
    tick.value += 1;
    await nextTick();
    expect(box()).toBe(first);

    held.value = { title: `Queued`, rows: [{ label: `Ahead`, value: 1 }] };
    await nextTick();
    expect(box()).not.toBe(first);
    expect(box()?.querySelector(`dd`)?.textContent).toBe(`1`);
    done();
});
