// A pane's width, measured the moment its element arrives: the observer's first answer can land a frame after the first
// paint, and a phone drew that frame in the wide layout and then folded it, shifting everything under it.
import "@intentic/testing/dom";
import { useNarrow } from "@intentic/ui";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

const mountAt = async (width: number) => {
    let narrow!: ReturnType<typeof useNarrow>;
    const app = createApp(
        defineComponent({
            setup() {
                const element = ref<HTMLElement | undefined>(undefined);
                narrow = useNarrow(element, 48);
                return () =>
                    h(`div`, {
                        ref: (el: unknown) => {
                            const box = el instanceof HTMLElement ? el : undefined;
                            if (box !== undefined) {
                                // SAFETY: useNarrow reads only `width` off the box it measures.
                                box.getBoundingClientRect = () => ({ width }) as DOMRect;
                            }
                            element.value = box;
                        },
                    });
            },
        }),
    );
    const host = document.createElement(`div`);
    document.body.append(host);
    app.mount(host);
    await nextTick();
    return { narrow, done: () => app.unmount() };
};

it(`answers from the element's own width before the observer has said anything`, async () => {
    // The setup's ResizeObserver never fires, which is the frame this is about.
    const phone = await mountAt(412);
    expect(phone.narrow.value).toBe(true);
    phone.done();

    const desk = await mountAt(1_400);
    expect(desk.narrow.value).toBe(false);
    desk.done();
});
