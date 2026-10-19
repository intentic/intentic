//
// A HUB SECTION WHOSE CODE ARRIVES WHEN IT IS OPENED. What the reader sees while it is on its way (nothing for a short
// wait, the outline only past the reveal delay), that the section gets the props and slots its hub hands it, that a
// failed chunk is said and fetched again, and that once the open section has drawn the hub warms the rest one at a
// time, so the next section opened draws at once.
import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { REVEAL_DELAY_MS } from "@intentic/ui";
import { IconStub } from "@intentic/ui/testing";
import { type App, type Component, createApp, defineComponent, h, nextTick } from "vue";
import { createMemoryHistory, createRouter } from "vue-router";
import { lazySection, sectionLanded, useSectionWarmup } from "./lazySection";
import { seekSetting } from "./settingAnchor";

interface Gate {
    readonly load: () => Promise<{ readonly default: Component }>;
    readonly open: () => void;
    readonly fail: (error: Error) => void;
    readonly asked: () => number;
}

// A chunk that arrives when the test says so: each ask is a fresh fetch, as a real import is after a failed one.
const gate = (section: Component): Gate => {
    let asked = 0;
    let settle: { open: () => void; fail: (error: Error) => void } | undefined;
    return {
        load: () => {
            asked += 1;
            return new Promise((resolve, reject) => {
                settle = { open: () => resolve({ default: section }), fail: reject };
            });
        },
        open: () => settle?.open(),
        fail: (error) => settle?.fail(error),
        asked: () => asked,
    };
};

// A section that shows what it was handed: a prop, and the hub's slot.
const Shown = defineComponent({
    props: { label: { type: String, required: true } },
    setup(props, { slots }) {
        return () => h(`article`, { "data-section": props.label }, slots[`turns`]?.());
    },
});

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: `/sandbox/:tab?`, component: { render: () => undefined } }] });

let app: App | undefined;

const mount = async (render: () => ReturnType<typeof h>, setup?: () => void): Promise<HTMLElement> => {
    await router.push(`/sandbox/usage`);
    await router.isReady();
    const el = document.createElement(`div`);
    document.body.append(el);
    app = createApp({
        setup() {
            setup?.();
            return render;
        },
    });
    app.component(`Icon`, IconStub);
    app.use(router);
    app.mount(el);
    await nextTick();
    return el;
};

// Lets a settled chunk reach the screen: its promise chain, then the render it queued.
const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
};

const outline = (el: HTMLElement): Element | null => el.querySelector(`[role="status"][aria-busy="true"]`);

afterEach(() => {
    jest.useRealTimers();
    unstubAllGlobals();
    app?.unmount();
    app = undefined;
    document.body.innerHTML = ``;
});

it(`draws nothing for a short wait, the outline past the reveal delay, then the section with its props and slots`, async () => {
    jest.useFakeTimers();
    const chunk = gate(Shown);
    const Section = lazySection(chunk.load);
    const el = await mount(() => h(Section, { label: `usage` }, { turns: () => h(`p`, { "data-turns": `` }) }));

    expect(el.textContent).toBe(``);
    jest.advanceTimersByTime(REVEAL_DELAY_MS - 1);
    await nextTick();
    expect(outline(el)).toBeNull();
    jest.advanceTimersByTime(1);
    await nextTick();
    expect(outline(el)).not.toBeNull();

    chunk.open();
    jest.useRealTimers();
    await settle();
    expect(outline(el)).toBeNull();
    expect(el.querySelector(`[data-section="usage"] [data-turns]`)).not.toBeNull();
});

it(`draws a section it has drawn once at once, without asking for its chunk again`, async () => {
    const chunk = gate(Shown);
    const Section = lazySection(chunk.load);
    const first = await mount(() => h(Section, { label: `usage` }));
    chunk.open();
    await settle();
    expect(first.querySelector(`[data-section="usage"]`)).not.toBeNull();
    app?.unmount();

    const again = await mount(() => h(Section, { label: `usage` }));
    expect(again.querySelector(`[data-section="usage"]`)).not.toBeNull();
    expect(chunk.asked()).toBe(1);
});

it(`says a chunk failed, and fetches it afresh on Try again`, async () => {
    const chunk = gate(Shown);
    const Section = lazySection(chunk.load);
    const el = await mount(() => h(Section, { label: `usage` }));
    chunk.fail(new Error(`the server said no`));
    await settle();
    expect(el.textContent).toContain(`the server said no`);

    const retry = [...el.querySelectorAll(`button`)].find((button) => button.textContent?.includes(`Try again`));
    retry?.click();
    await nextTick();
    expect(chunk.asked()).toBe(2);
    chunk.open();
    await settle();
    expect(el.querySelector(`[data-section="usage"]`)).not.toBeNull();
});

// A search answer's address (`#setting-<id>`) is sought as the route settles (HubLayout.vue), which is now before the
// section's code is in: the landing waits for the card its chunk draws, well inside its deadline.
it(`lands a deep link on a card inside a section whose code is still on its way`, async () => {
    const original = Element.prototype.scrollTo;
    Element.prototype.scrollTo = () => undefined;
    try {
        const chunk = gate(defineComponent({ render: () => h(`div`, { "data-setting": `usage-limits` }) }));
        const Section = lazySection(chunk.load);
        await mount(() => h(Section));
        const landing = seekSetting(`usage-limits`);
        chunk.open();
        expect(await landing).toBe(true);
        expect(document.activeElement?.getAttribute(`data-setting`)).toBe(`usage-limits`);
    } finally {
        Element.prototype.scrollTo = original;
    }
});

it(`warms the other sections one at a time once the open one has drawn, and stops when the hub goes`, async () => {
    const idle: (() => void)[] = [];
    stubGlobal(`requestIdleCallback`, (callback: () => void) => idle.push(callback));
    const runIdle = async (): Promise<void> => {
        idle.shift()?.();
        await settle();
    };
    const [open, second, third] = [gate(Shown), gate(Shown), gate(Shown)];
    const Open = lazySection(open.load);
    const Second = lazySection(second.load);
    const Third = lazySection(third.load);
    await mount(
        () => h(Open, { label: `usage` }),
        () => useSectionWarmup(() => [Open, Second, Third]),
    );

    // The open section's chunk goes first, alone.
    await settle();
    expect(idle).toHaveLength(0);
    expect([second.asked(), third.asked()]).toEqual([0, 0]);

    open.open();
    await settle();
    await runIdle();
    expect([second.asked(), third.asked()]).toEqual([1, 0]);

    second.open();
    await settle();
    expect(sectionLanded(Second)).toBe(true);
    await runIdle();
    expect(third.asked()).toBe(1);

    // A failure is the click path's to retry: the walk moves on and does not ask again.
    third.fail(new Error(`offline`));
    await settle();
    app?.unmount();
    app = undefined;
    await runIdle();
    expect(third.asked()).toBe(1);
    expect(idle).toHaveLength(0);
});
