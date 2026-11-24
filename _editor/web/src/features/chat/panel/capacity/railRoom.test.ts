import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { useRailRoom } from "./railRoom";

// Pins how the chat's reading column answers the rail coming and going: drawn at once where it now stands, it slides
// from where its text started, so it never jumps sideways under the reader; with less motion it simply stands there.

describe(`useRailRoom`, () => {
    const slides: { readonly on: Element; readonly keyframes: Keyframe[] }[] = [];
    let app: App | undefined;

    beforeEach(() => {
        slides.length = 0;
        Object.defineProperty(Element.prototype, `animate`, {
            configurable: true,
            value(this: Element, keyframes: Keyframe[]): Animation | undefined {
                slides.push({ on: this, keyframes });
                return undefined;
            },
        });
        stubGlobal(`matchMedia`, (query: string) => ({ matches: false, media: query }));
    });

    afterEach(() => {
        app?.unmount();
        app = undefined;
        Reflect.deleteProperty(Element.prototype, `animate`);
        jest.restoreAllMocks();
        unstubAllGlobals();
    });

    // A panel with one pane whose footer starts 120px further left once the rail stands beside it, as the column
    // re-centres in the narrower room (jsdom lays nothing out).
    const drawn = () => {
        const rail = ref(false);
        jest.spyOn(Element.prototype, `getBoundingClientRect`).mockImplementation(function (this: Element) {
            const left = this.hasAttribute(`data-lane-floor`) ? (this.closest(`[data-rail]`) === null ? 420 : 300) : 0;
            return DOMRect.fromRect({ x: left, y: 0, width: 600, height: 80 });
        });
        const Panel = defineComponent({
            setup() {
                const root = ref<HTMLElement>();
                useRailRoom(root, () => rail.value);
                // The rail drawn is what moves the footer: measured before the render that draws it, and after.
                return () =>
                    h(`div`, { ref: root, "data-rail": rail.value ? `` : undefined }, [
                        h(`div`, { class: `chat-pane` }, [h(`div`, { "data-content": `` }, [h(`div`, { "data-lane-floor": `` })])]),
                    ]);
            },
        });
        const root = document.createElement(`div`);
        document.body.appendChild(root);
        app = createApp(Panel);
        app.mount(root);
        return { rail, content: (): Element | undefined => root.querySelector(`[data-content]`) ?? undefined };
    };

    it(`slides the column from where its text started when the rail arrives, and back when it leaves`, async () => {
        const { rail, content } = drawn();
        await nextTick();
        expect(slides).toHaveLength(0);

        rail.value = true;
        await nextTick();
        expect(slides).toHaveLength(1);
        expect(slides[0]?.on).toBe(content());
        expect(slides[0]?.keyframes).toEqual([{ translate: `120px 0` }, { translate: `0 0` }]);

        rail.value = false;
        await nextTick();
        expect(slides[1]?.keyframes[0]).toEqual({ translate: `-120px 0` });
    });

    it(`leaves the column where it now stands for a reader who asked for less motion`, async () => {
        stubGlobal(`matchMedia`, (query: string) => ({ matches: query === `(prefers-reduced-motion: reduce)`, media: query }));
        const { rail } = drawn();
        await nextTick();

        rail.value = true;
        await nextTick();
        expect(slides).toHaveLength(0);
    });
});
