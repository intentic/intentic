// The fact three production crashes rested on: a `ref<HTMLElement>()` bound to a template ref is typed
// `HTMLElement | undefined`, but Vue writes NULL into it when the element goes, so `x === undefined` guards let a
// null through into `.offsetHeight`, `.style` and `observe()`. Pinned here because nothing else in the app states
// it, and every guard on a template ref is written against it.
import "@intentic/testing/dom";
import { createApp, defineComponent, h, nextTick, ref } from "vue";

it("Vue clears a template ref to null, not undefined, when its element unmounts", async () => {
    const el = ref<HTMLElement>();
    const shown = ref(true);
    const Probe = defineComponent({ setup: () => () => (shown.value ? h(`div`, { ref: el }) : h(`span`)) });
    const host = document.createElement(`div`);
    document.body.append(host);
    const app = createApp(Probe);
    app.mount(host);
    await nextTick();
    expect(el.value).toBeInstanceOf(HTMLElement);

    // A `v-if` going false, not a component unmount: the owning component stays alive and its watchers keep firing.
    shown.value = false;
    await nextTick();
    expect(el.value).toBeNull();
    expect(el.value === undefined).toBe(false);

    app.unmount();
    host.remove();
});
