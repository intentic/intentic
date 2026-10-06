// publishSlot: a surface clears a panel slot on its way out only while the slot is still its own, so a surface that
// mounted before it left (a route swap, a remount) keeps the slot it just published.
import "@intentic/testing/dom";
import { type App, createApp, defineComponent, h, shallowRef, useTemplateRef } from "vue";
import { publishSlot } from "./panelSlots";

const slot = shallowRef<HTMLElement | null>(null);

// A surface that publishes its one element, tagged so the assertion can say whose it is.
const Surface = defineComponent({
    props: { name: { type: String, required: true } },
    setup: (props) => {
        const element = useTemplateRef<HTMLElement>(`slot`);
        publishSlot(slot, () => element.value);
        return () => h(`div`, { ref: `slot`, "data-surface": props.name });
    },
});

const mountSurface = (name: string): App => {
    const app = createApp(Surface, { name });
    app.mount(document.body.appendChild(document.createElement(`div`)));
    return app;
};

const holder = (): string | undefined => slot.value?.dataset[`surface`];

afterEach(() => {
    slot.value = null;
    document.body.replaceChildren();
});

describe(`publishSlot`, () => {
    it(`publishes on mount and clears its own slot on unmount`, () => {
        const app = mountSurface(`a`);
        expect(holder()).toBe(`a`);
        app.unmount();
        expect(slot.value).toBeNull();
    });

    it(`leaves a later publisher's slot alone when the earlier surface unmounts`, () => {
        const first = mountSurface(`first`);
        const second = mountSurface(`second`);
        expect(holder()).toBe(`second`);
        first.unmount();
        expect(holder()).toBe(`second`);
        second.unmount();
        expect(slot.value).toBeNull();
    });
});
