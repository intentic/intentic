// @vitest-environment jsdom
// The close gesture every tab strip shares, pinned here since @intentic/ui has no test runner of its own. jsdom
// has neither autoscroll nor a primary selection, so the platform's middle-press default is asserted as
// `defaultPrevented` rather than by what it would have started.
import { expect, it, vi } from "vitest";
import { createApp, h, nextTick, ref, withDirectives } from "vue";
import { vMiddleclick } from "@intentic/ui";

// A strip holding one tab, mounted the way the compiler mounts a template: `withDirectives` is what `v-middleclick`
// becomes. `held` drops the tab, for the case where a close removes the very pill that was pressed.
const strip = (handler: (event: MouseEvent) => void, held = ref(true)) => {
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({
        render: () =>
            h(`div`, { class: `strip` }, held.value ? [withDirectives(h(`div`, { class: `tab` }, [h(`span`, { class: `label` }, `tab`)]), [[vMiddleclick, handler]])] : []),
    });
    app.mount(host);
    const tab = host.querySelector<HTMLElement>(`.tab`)!;
    return { app, host, tab, label: tab.querySelector<HTMLElement>(`.label`)! };
};

const press = (el: HTMLElement, button: number, type = `auxclick`): MouseEvent => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, button });
    el.dispatchEvent(event);
    return event;
};

it(`closes on the middle button and ignores the other two`, () => {
    const closed = vi.fn();
    const { tab, app, host } = strip(closed);

    press(tab, 1);
    expect(closed).toHaveBeenCalledTimes(1);

    press(tab, 0);
    press(tab, 2);
    expect(closed).toHaveBeenCalledTimes(1);

    app.unmount();
    host.remove();
});

// A press on the glyph inside the pill is a press on the pill: the gesture is the tab's, not the leaf's.
it(`answers a press on anything inside the tab`, () => {
    const closed = vi.fn();
    const { label, app, host } = strip(closed);

    press(label, 1);

    expect(closed).toHaveBeenCalledTimes(1);
    app.unmount();
    host.remove();
});

// Autoscroll (and X11's paste) start on mousedown and would outlive the pill the close removes.
it(`takes the platform's middle-press default away, and leaves the other buttons theirs`, () => {
    const { tab, app, host } = strip(vi.fn());

    expect(press(tab, 1, `mousedown`).defaultPrevented).toBe(true);
    expect(press(tab, 0, `mousedown`).defaultPrevented).toBe(false);

    app.unmount();
    host.remove();
});

// The strip underneath has gestures of its own (selection, its own context menu); a press that closed a tab is spent.
it(`keeps the press off the strip underneath`, () => {
    const onStrip = vi.fn();
    const { tab, host, app } = strip(vi.fn());
    host.querySelector<HTMLElement>(`.strip`)!.addEventListener(`auxclick`, onStrip);

    const event = press(tab, 1);

    expect(onStrip).not.toHaveBeenCalled();
    // A card that is also a link would otherwise open itself in a background tab on the way out.
    expect(event.defaultPrevented).toBe(true);
    app.unmount();
    host.remove();
});

// Listeners are the element's own, so a tab that has left the strip must not answer a press aimed at where it was.
it(`stops listening once the tab is gone`, async () => {
    const closed = vi.fn();
    const held = ref(true);
    const { tab, app, host } = strip(closed, held);

    held.value = false;
    await nextTick();
    press(tab, 1);

    expect(closed).not.toHaveBeenCalled();
    app.unmount();
    host.remove();
});

// The list re-renders around a stable element (a tab that changed id, a card the filter moved); the press must reach
// the handler the latest render bound, not the one captured at mount.
it(`closes what the latest render named, not what the first did`, async () => {
    const closed: string[] = [];
    const id = ref(`first`);
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp({
        render: () => {
            // Read at render time, as a `v-for` row's handler closes over the row it was drawn for.
            const named = id.value;
            return withDirectives(h(`div`, { class: `tab` }), [[vMiddleclick, () => closed.push(named)]]);
        },
    });
    app.mount(host);

    id.value = `second`;
    await nextTick();
    press(host.querySelector<HTMLElement>(`.tab`)!, 1);

    expect(closed).toEqual([`second`]);
    app.unmount();
    host.remove();
});
